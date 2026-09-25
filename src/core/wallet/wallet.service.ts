import { Prisma, TransactionType, ServiceType } from "@prisma/client";
import bcrypt from "bcryptjs";
import { db } from "../../db.js";
import { InsufficientFundsError, NotFoundError, ConflictError, AppError } from "../errors/app-error.js";
import { eventBus } from "../events/index.js";
import { getConfigNumber, CONFIG_KEYS } from "../config/system-config.service.js";

export type PrismaTransactionClient = Prisma.TransactionClient;

export interface SettleOrderResult {
  orderId: string;
  serviceType: ServiceType;
  totalPrice: number;
  commissionAmount: number;
  providerPayoutAmount: number;
  vendorPayoutAmount?: number;
  transactions: {
    id: string;
    walletAccountId: string;
    amount: number;
    type: TransactionType;
    description: string | null;
  }[];
}

/**
 * Get or create wallet for a user.
 * Drivers and workers are granted an authorized overdraft credit limit (configurable from admin).
 */
export async function getOrCreateWallet(userId: string, tx: PrismaTransactionClient = db) {
  let wallet = await tx.walletAccount.findUnique({
    where: { userId },
  });

  const isDriverOrWorker = await tx.userRole.findFirst({
    where: {
      userId,
      role: { name: { in: ["driver", "worker"] } },
    },
  });

  // Resolve overdraft limit from SystemConfig (dynamic, admin-configurable)
  let authorizedOverdraft = 0.00;
  if (isDriverOrWorker) {
    const roleCheck = await tx.userRole.findFirst({
      where: { userId, role: { name: "driver" } },
    });
    const cfgKey = roleCheck ? CONFIG_KEYS.DRIVER_OVERDRAFT_LIMIT : CONFIG_KEYS.WORKER_OVERDRAFT_LIMIT;
    authorizedOverdraft = await getConfigNumber(cfgKey, 1500);
  }

  if (!wallet) {
    wallet = await tx.walletAccount.create({
      data: {
        userId,
        balance: 0,
        overdraftLimit: authorizedOverdraft,
        currency: "EGP",
      },
    });
  } else if (isDriverOrWorker && Number(wallet.overdraftLimit) === 0) {
    wallet = await tx.walletAccount.update({
      where: { id: wallet.id },
      data: { overdraftLimit: authorizedOverdraft },
    });
  }

  return wallet;
}


/**
 * Get wallet balance by wallet account ID.
 */
export async function getBalance(walletAccountId: string, tx: PrismaTransactionClient = db): Promise<number> {
  const wallet = await tx.walletAccount.findUnique({
    where: { id: walletAccountId },
  });
  if (!wallet) throw new NotFoundError("WalletAccount", walletAccountId);
  return Number(wallet.balance);
}

/**
 * Credit an amount to a wallet account.
 * Atomically updates balance, generates ledger transaction row, and records audit trail.
 */
export async function credit(
  walletAccountId: string,
  amount: number,
  type: TransactionType,
  orderId?: string,
  description?: string,
  tx?: PrismaTransactionClient,
  meta?: {
    referenceId?: string;
    senderName?: string;
    recipientName?: string;
    status?: string;
  }
) {
  if (amount <= 0) throw new Error("Credit amount must be greater than zero");

  const runWithTx = async (prismaTx: PrismaTransactionClient) => {
    // 1. Fetch current wallet
    const current = await prismaTx.walletAccount.findUnique({
      where: { id: walletAccountId },
    });
    if (!current) throw new NotFoundError("WalletAccount", walletAccountId);

    const preBalance = Number(current.balance);
    const postBalance = Math.round((preBalance + amount) * 100) / 100;

    // 2. Atomic balance update
    const wallet = await prismaTx.walletAccount.update({
      where: { id: walletAccountId },
      data: {
        balance: { increment: amount },
      },
    });

    const auditDesc = description
      ? `${description} [Pre: $${preBalance.toFixed(2)}, Post: $${postBalance.toFixed(2)}]`
      : `Credit [Pre: $${preBalance.toFixed(2)}, Post: $${postBalance.toFixed(2)}]`;

    // 3. Create immutable audit transaction record
    const transaction = await prismaTx.walletTransaction.create({
      data: {
        walletAccountId,
        orderId,
        amount,
        type,
        description: auditDesc,
        preBalance,
        postBalance,
        referenceId: meta?.referenceId,
        senderName: meta?.senderName,
        recipientName: meta?.recipientName,
        status: meta?.status || "COMPLETED",
      },
    });

    eventBus.publish("wallet:transaction", {
      walletAccountId,
      orderId,
      amount,
      type,
    });

    return { wallet, transaction };
  };

  if (tx) {
    return runWithTx(tx);
  }
  return db.$transaction(runWithTx);
}

/**
 * Debit an amount from a wallet account.
 * Strict zero-overdraft for regular customers (balance cannot drop below 0).
 * Drivers and workers have an authorized overdraft line allowing balance down to -1500 EGP.
 */
export async function debit(
  walletAccountId: string,
  amount: number,
  type: TransactionType,
  orderId?: string,
  description?: string,
  tx?: PrismaTransactionClient,
  meta?: {
    referenceId?: string;
    senderName?: string;
    recipientName?: string;
    status?: string;
  }
) {
  if (amount <= 0) throw new Error("Debit amount must be greater than zero");

  const runWithTx = async (prismaTx: PrismaTransactionClient) => {
    const current = await prismaTx.walletAccount.findUnique({
      where: { id: walletAccountId },
    });
    if (!current) throw new NotFoundError("WalletAccount", walletAccountId);

    const isDriverOrWorker = await prismaTx.userRole.findFirst({
      where: {
        userId: current.userId,
        role: { name: { in: ["driver", "worker"] } },
      },
    });

    // Use wallet's stored overdraftLimit (set at creation via SystemConfig).
    // Fall back to SystemConfig only if wallet.overdraftLimit is zero (legacy wallets).
    let maxOverdraft = Number(current.overdraftLimit);
    if (maxOverdraft === 0 && isDriverOrWorker) {
      const roleCheck = await prismaTx.userRole.findFirst({
        where: { userId: current.userId, role: { name: "driver" } },
      });
      const cfgKey = roleCheck ? CONFIG_KEYS.DRIVER_OVERDRAFT_LIMIT : CONFIG_KEYS.WORKER_OVERDRAFT_LIMIT;
      maxOverdraft = await getConfigNumber(cfgKey, 1500);
    }

    const preBalance = Number(current.balance);
    const postBalance = Math.round((preBalance - amount) * 100) / 100;

    // Check if debit exceeds allowable overdraft limit
    if (postBalance < -maxOverdraft) {
      if (maxOverdraft > 0) {
        throw new Error(
          `Driver credit limit exceeded: Balance cannot drop below -$${maxOverdraft.toFixed(2)}. Current balance is $${preBalance.toFixed(2)}, requested debit is $${amount.toFixed(2)}.`
        );
      }
      throw new InsufficientFundsError(preBalance, amount);
    }

    // Concurrency safe decrement
    const wallet = await prismaTx.walletAccount.update({
      where: { id: walletAccountId },
      data: {
        balance: { decrement: amount },
      },
    });

    const auditDesc = description
      ? `${description} [Pre: $${preBalance.toFixed(2)}, Post: $${postBalance.toFixed(2)}]`
      : `Debit [Pre: $${preBalance.toFixed(2)}, Post: $${postBalance.toFixed(2)}]`;

    const transaction = await prismaTx.walletTransaction.create({
      data: {
        walletAccountId,
        orderId,
        amount: -amount,
        type,
        description: auditDesc,
        preBalance,
        postBalance,
        referenceId: meta?.referenceId,
        senderName: meta?.senderName,
        recipientName: meta?.recipientName,
        status: meta?.status || "COMPLETED",
      },
    });

    eventBus.publish("wallet:transaction", {
      walletAccountId,
      orderId,
      amount: -amount,
      type,
    });

    return { wallet, transaction };
  };

  if (tx) {
    return runWithTx(tx);
  }
  return db.$transaction(runWithTx);
}

/**
 * Top up user's wallet with payment proof/reference.
 */
export async function topupWallet(userId: string, amount: number, paymentRef: string, method: string = "card") {
  return db.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(userId, tx);
    return credit(
      wallet.id,
      amount,
      TransactionType.topup,
      undefined,
      `Wallet topup via ${method} (Ref: ${paymentRef})`,
      tx
    );
  });
}

/**
 * Find platform wallet account (admin user's wallet).
 */
async function getPlatformWallet(tx: PrismaTransactionClient) {
  const adminRole = await tx.role.findUnique({ where: { name: "admin" } });
  if (adminRole) {
    const adminUserRole = await tx.userRole.findFirst({
      where: { roleId: adminRole.id },
      include: { user: true },
    });
    if (adminUserRole) {
      return getOrCreateWallet(adminUserRole.userId, tx);
    }
  }

  const firstUser = await tx.user.findFirst();
  if (firstUser) {
    return getOrCreateWallet(firstUser.id, tx);
  }
  throw new Error("No platform ledger account available");
}

/**
 * Idempotent, Atomic Order Settlement upon order completion.
 * Reads CommissionRule and splits funds in one atomic DB transaction.
 */
export async function settleOrder(orderId: string): Promise<SettleOrderResult> {
  return db.$transaction(async (tx) => {
    // 1. Idempotency Check: Prevent duplicate settlement for the same order
    const existingSettlement = await tx.walletTransaction.findFirst({
      where: { orderId, type: TransactionType.commission },
    });
    if (existingSettlement) {
      const allOrderTxs = await tx.walletTransaction.findMany({ where: { orderId } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      return {
        orderId,
        serviceType: order.serviceType,
        totalPrice: Number(order.priceFinal ?? order.total),
        commissionAmount: Number(existingSettlement.amount),
        providerPayoutAmount: 0,
        transactions: allOrderTxs.map((t) => ({
          id: t.id,
          walletAccountId: t.walletAccountId,
          amount: Number(t.amount),
          type: t.type,
          description: t.description,
        })),
      };
    }

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        provider: true,
        items: {
          include: {
            product: {
              include: { vendor: true },
            },
          },
        },
      },
    });

    if (!order) throw new NotFoundError("Order", orderId);

    const totalPrice = Number(order.priceFinal ?? order.total);
    if (totalPrice <= 0) {
      throw new Error(`Cannot settle order with zero or negative price: ${totalPrice}`);
    }

    // 2. Commission Rule Lookup — DB first, SystemConfig fallback
    const rule = await tx.commissionRule.findUnique({
      where: { serviceType: order.serviceType },
    });
    const defaultCommissionPct = await getConfigNumber(CONFIG_KEYS.DEFAULT_COMMISSION_PCT, 15);
    const commissionPct = rule ? Number(rule.percentage) : defaultCommissionPct;
    const commissionAmount = Math.round((totalPrice * commissionPct) / 100 * 100) / 100;

    const platformWallet = await getPlatformWallet(tx);
    const createdTransactions: any[] = [];

    let providerPayoutAmount = 0;
    let vendorPayoutAmount = 0;

    if (order.serviceType === ServiceType.food) {
      // 1. Food Subtotal vs Delivery Fee
      let foodSubtotal = 0;
      if (order.items && order.items.length > 0) {
        foodSubtotal = order.items.reduce((acc, it) => acc + (Number(it.unitPrice) * it.quantity), 0);
      }
      if (foodSubtotal <= 0 || foodSubtotal > totalPrice) {
        foodSubtotal = Math.round((totalPrice * 0.80) * 100) / 100;
      }
      const deliveryFee = Math.round((totalPrice - foodSubtotal) * 100) / 100;

      // 2. Exact Business Fee Breakdown from SystemConfig (admin-configurable):
      // Restaurant: platform fee % on food subtotal
      // Courier: platform fee % on delivery fee
      const configuredVendorFeePct = await getConfigNumber(CONFIG_KEYS.FOOD_VENDOR_FEE_PCT, 2);
      const configuredCourierFeePct = await getConfigNumber(CONFIG_KEYS.FOOD_COURIER_FEE_PCT, 1);
      const vendorFeePct = rule ? (Number(rule.percentage) >= 10 ? configuredVendorFeePct : Number(rule.percentage)) : configuredVendorFeePct;
      const courierFeePct = configuredCourierFeePct;

      const vendorFee = Math.round((foodSubtotal * (vendorFeePct / 100)) * 100) / 100;
      const courierFee = Math.round((deliveryFee * (courierFeePct / 100)) * 100) / 100;
      const totalCommission = Math.round((vendorFee + courierFee) * 100) / 100;

      vendorPayoutAmount = Math.round((foodSubtotal - vendorFee) * 100) / 100;
      providerPayoutAmount = Math.round((deliveryFee - courierFee) * 100) / 100;

      // Credit platform commission
      const { transaction: platformTx } = await credit(
        platformWallet.id,
        totalCommission > 0 ? totalCommission : commissionAmount,
        TransactionType.commission,
        order.id,
        `Platform commission (${vendorFeePct}% vendor + ${courierFeePct}% courier) on order ${order.id}`,
        tx
      );
      createdTransactions.push(platformTx);

      // Identify vendor owner
      let vendorOwnerUserId: string | null = null;
      if (order.items.length && order.items[0].product?.vendor?.ownerUserId) {
        vendorOwnerUserId = order.items[0].product.vendor.ownerUserId;
      } else {
        const anyVendor = await tx.vendor.findFirst();
        if (anyVendor) vendorOwnerUserId = anyVendor.ownerUserId;
      }

      if (vendorOwnerUserId && vendorPayoutAmount > 0) {
        const vendorWallet = await getOrCreateWallet(vendorOwnerUserId, tx);
        const { transaction: vTx } = await credit(
          vendorWallet.id,
          vendorPayoutAmount,
          TransactionType.payout,
          order.id,
          `Vendor food payout ($${foodSubtotal.toFixed(2)} - ${vendorFeePct}% fee: $${vendorFee.toFixed(2)}) for order ${order.id}`,
          tx
        );
        createdTransactions.push(vTx);
      }

      // Provider/Courier payout
      const providerUserId = order.providerId || order.courierId;
      if (providerUserId && providerPayoutAmount > 0) {
        const providerWallet = await getOrCreateWallet(providerUserId, tx);
        const { transaction: pTx } = await credit(
          providerWallet.id,
          providerPayoutAmount,
          TransactionType.payout,
          order.id,
          `Delivery rider payout ($${deliveryFee.toFixed(2)} - ${courierFeePct}% fee: $${courierFee.toFixed(2)}) for order ${order.id}`,
          tx
        );
        createdTransactions.push(pTx);
      }
    } else {
      // Mobility / Handyman / Moving: Direct 2-party settlement (No courier intermediary)
      providerPayoutAmount = Math.round((totalPrice - commissionAmount) * 100) / 100;

      // Credit platform commission
      const { transaction: platformTx } = await credit(
        platformWallet.id,
        commissionAmount,
        TransactionType.commission,
        order.id,
        `Platform commission (${commissionPct}%) on order ${order.id}`,
        tx
      );
      createdTransactions.push(platformTx);

      const providerUserId = order.providerId;
      if (providerUserId && providerPayoutAmount > 0) {
        const providerWallet = await getOrCreateWallet(providerUserId, tx);
        const isHandyman = order.serviceType === ServiceType.handyman;
        const { transaction: pTx } = await credit(
          providerWallet.id,
          providerPayoutAmount,
          TransactionType.payout,
          order.id,
          isHandyman
            ? `Direct provider payout for handyman job (Carpenter/Plumber) order ${order.id}`
            : `Provider payout for ${order.serviceType} order ${order.id}`,
          tx
        );
        createdTransactions.push(pTx);
      }
    }

    return {
      orderId: order.id,
      serviceType: order.serviceType,
      totalPrice,
      commissionAmount,
      providerPayoutAmount,
      vendorPayoutAmount: order.serviceType === ServiceType.food ? vendorPayoutAmount : undefined,
      transactions: createdTransactions.map((t) => ({
        id: t.id,
        walletAccountId: t.walletAccountId,
        amount: Number(t.amount),
        type: t.type,
        description: t.description,
      })),
    };
  });
}

/**
 * Configure or update a secure 4-6 digit numeric wallet transaction PIN.
 */
export async function setWalletPin(userId: string, pin: string) {
  if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
    throw new AppError("Wallet PIN must be between 4 and 6 numeric digits", 400, "INVALID_PIN_FORMAT");
  }

  const wallet = await getOrCreateWallet(userId);
  const hashedPin = await bcrypt.hash(pin, 10);

  const updated = await db.walletAccount.update({
    where: { id: wallet.id },
    data: { securityPin: hashedPin },
  });

  return {
    success: true,
    message: "Wallet security PIN configured successfully",
    walletId: updated.id,
  };
}

/**
 * Verify a user's wallet PIN if configured.
 */
export async function verifyWalletPin(userId: string, pin?: string, tx: PrismaTransactionClient = db): Promise<boolean> {
  const wallet = await tx.walletAccount.findUnique({
    where: { userId },
  });
  if (!wallet) throw new NotFoundError("WalletAccount", userId);

  if (!wallet.securityPin) {
    return true; // No PIN configured on wallet
  }

  if (!pin) {
    throw new AppError("Security PIN is required to authorize this wallet action", 400, "PIN_REQUIRED");
  }

  const isValid = await bcrypt.compare(pin, wallet.securityPin);
  if (!isValid) {
    throw new AppError("Invalid wallet security PIN", 403, "INVALID_PIN");
  }

  return true;
}

/**
 * Peer-to-Peer Wallet Transfer between two accounts.
 * Atomically debits sender and credits recipient with double-entry database audit logging.
 * Enforces PIN verification if set on sender's wallet account.
 */
export async function transferBetweenWallets(params: {
  senderUserId: string;
  recipientIdentifier: string; // Phone number or User ID
  amount: number;
  notes?: string;
  referenceId?: string;
  pin?: string;
}) {
  const { senderUserId, recipientIdentifier, amount, notes, pin } = params;
  if (!amount || amount <= 0) {
    throw new Error("Transfer amount must be a positive number");
  }

  const generatedRef = params.referenceId || `TX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  return db.$transaction(async (tx) => {
    // 1. Resolve sender
    const sender = await tx.user.findUnique({ where: { id: senderUserId } });
    if (!sender) throw new NotFoundError("User", senderUserId);
    const senderWallet = await getOrCreateWallet(senderUserId, tx);

    // Verify PIN if set on sender's wallet
    if (senderWallet.securityPin) {
      if (!pin) {
        throw new AppError("Wallet security PIN is required for this transfer", 400, "PIN_REQUIRED");
      }
      const isMatch = await bcrypt.compare(pin, senderWallet.securityPin);
      if (!isMatch) {
        throw new AppError("Invalid wallet security PIN", 403, "INVALID_PIN");
      }
    }

    // 2. Resolve recipient by phone or user ID
    const recipient = await tx.user.findFirst({
      where: {
        OR: [
          { id: recipientIdentifier },
          { phone: recipientIdentifier },
        ],
      },
    });

    if (!recipient) {
      throw new NotFoundError("Recipient User", recipientIdentifier);
    }

    if (recipient.id === senderUserId) {
      throw new ConflictError("Cannot transfer funds to your own wallet account");
    }

    const recipientWallet = await getOrCreateWallet(recipient.id, tx);

    // 3. Strict Zero-Overdraft Check on sender
    const senderBalance = Number(senderWallet.balance);
    if (senderBalance < amount) {
      throw new InsufficientFundsError(amount, senderBalance);
    }

    // 4. Atomic Debit on Sender
    const debitRes = await debit(
      senderWallet.id,
      amount,
      TransactionType.payout,
      undefined,
      `P2P Transfer to ${recipient.name} (${recipient.phone}): ${notes || "Personal Transfer"} [Ref: ${generatedRef}]`,
      tx,
      {
        referenceId: generatedRef,
        senderName: sender.name,
        recipientName: recipient.name,
        status: "COMPLETED",
      }
    );

    // 5. Atomic Credit on Recipient
    const creditRes = await credit(
      recipientWallet.id,
      amount,
      TransactionType.topup,
      undefined,
      `P2P Transfer received from ${sender.name} (${sender.phone}): ${notes || "Personal Transfer"} [Ref: ${generatedRef}]`,
      tx,
      {
        referenceId: generatedRef,
        senderName: sender.name,
        recipientName: recipient.name,
        status: "COMPLETED",
      }
    );

    return {
      success: true,
      referenceId: generatedRef,
      amount,
      sender: {
        userId: sender.id,
        name: sender.name,
        newBalance: Number(debitRes.wallet.balance),
      },
      recipient: {
        userId: recipient.id,
        name: recipient.name,
        phone: recipient.phone,
      },
      transactions: [
        {
          id: debitRes.transaction.id,
          referenceId: generatedRef,
          type: "debit",
          amount,
          preBalance: debitRes.transaction.preBalance ? Number(debitRes.transaction.preBalance) : undefined,
          postBalance: debitRes.transaction.postBalance ? Number(debitRes.transaction.postBalance) : undefined,
          description: debitRes.transaction.description,
          createdAt: debitRes.transaction.createdAt,
        },
        {
          id: creditRes.transaction.id,
          referenceId: generatedRef,
          type: "credit",
          amount,
          preBalance: creditRes.transaction.preBalance ? Number(creditRes.transaction.preBalance) : undefined,
          postBalance: creditRes.transaction.postBalance ? Number(creditRes.transaction.postBalance) : undefined,
          description: creditRes.transaction.description,
          createdAt: creditRes.transaction.createdAt,
        },
      ],
    };
  });
}

/**
 * Request money from another user by phone number.
 */
export async function requestMoney(params: {
  requesterUserId: string;
  payerPhone: string;
  amount: number;
  note?: string;
}) {
  const { requesterUserId, payerPhone, amount, note } = params;
  if (!amount || amount <= 0) {
    throw new Error("Requested amount must be greater than zero");
  }
  if (!payerPhone) {
    throw new Error("Payer phone number is required");
  }

  const requester = await db.user.findUnique({ where: { id: requesterUserId } });
  if (!requester) throw new NotFoundError("User", requesterUserId);

  if (requester.phone === payerPhone.trim()) {
    throw new ConflictError("Cannot request money from yourself");
  }

  const transferRequest = await db.walletTransferRequest.create({
    data: {
      requesterId: requesterUserId,
      payerPhone: payerPhone.trim(),
      amount,
      note: note?.trim(),
      status: "PENDING",
    },
    include: {
      requester: { select: { id: true, name: true, phone: true } },
    },
  });

  return transferRequest;
}

/**
 * Pay / Fulfill a pending transfer request.
 */
export async function payTransferRequest(params: {
  requestId: string;
  payerUserId: string;
  pin?: string;
}) {
  const { requestId, payerUserId, pin } = params;

  const payer = await db.user.findUnique({ where: { id: payerUserId } });
  if (!payer) throw new NotFoundError("User", payerUserId);

  const request = await db.walletTransferRequest.findUnique({
    where: { id: requestId },
    include: { requester: true },
  });

  if (!request) {
    throw new NotFoundError("WalletTransferRequest", requestId);
  }

  if (request.status !== "PENDING") {
    throw new AppError(`Cannot pay transfer request with status '${request.status}'`, 400, "INVALID_REQUEST_STATUS");
  }

  if (request.payerPhone !== payer.phone) {
    throw new AppError("You are not authorized to pay this request (phone mismatch)", 403, "UNAUTHORIZED_PAYER");
  }

  // Execute transfer from payer to requester
  const transferResult = await transferBetweenWallets({
    senderUserId: payerUserId,
    recipientIdentifier: request.requesterId,
    amount: Number(request.amount),
    notes: request.note ? `Payment for request: ${request.note}` : "Payment for transfer request",
    pin,
  });

  // Mark request as ACCEPTED
  const updatedRequest = await db.walletTransferRequest.update({
    where: { id: requestId },
    data: {
      status: "ACCEPTED",
      settledAt: new Date(),
    },
    include: {
      requester: { select: { id: true, name: true, phone: true } },
    },
  });

  return {
    success: true,
    request: updatedRequest,
    transfer: transferResult,
  };
}

/**
 * Reject a pending transfer request.
 */
export async function rejectTransferRequest(params: {
  requestId: string;
  payerUserId: string;
  reason?: string;
}) {
  const { requestId, payerUserId } = params;

  const payer = await db.user.findUnique({ where: { id: payerUserId } });
  if (!payer) throw new NotFoundError("User", payerUserId);

  const request = await db.walletTransferRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new NotFoundError("WalletTransferRequest", requestId);
  }

  if (request.status !== "PENDING") {
    throw new AppError(`Cannot reject transfer request with status '${request.status}'`, 400, "INVALID_REQUEST_STATUS");
  }

  if (request.payerPhone !== payer.phone) {
    throw new AppError("You are not authorized to reject this request", 403, "UNAUTHORIZED_PAYER");
  }

  const updatedRequest = await db.walletTransferRequest.update({
    where: { id: requestId },
    data: {
      status: "REJECTED",
      settledAt: new Date(),
    },
  });

  return {
    success: true,
    message: "Transfer request rejected",
    request: updatedRequest,
  };
}

/**
 * List transfer requests for a user (incoming, outgoing, or all).
 */
export async function listTransferRequests(userId: string, filter: "incoming" | "outgoing" | "all" = "all") {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User", userId);

  let whereClause: Prisma.WalletTransferRequestWhereInput = {};
  if (filter === "incoming") {
    whereClause = { payerPhone: user.phone };
  } else if (filter === "outgoing") {
    whereClause = { requesterId: userId };
  } else {
    whereClause = {
      OR: [
        { requesterId: userId },
        { payerPhone: user.phone },
      ],
    };
  }

  const requests = await db.walletTransferRequest.findMany({
    where: whereClause,
    include: {
      requester: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return requests;
}

/**
 * Get full immutable transaction receipt for auditing and user download.
 */
export async function getTransactionReceipt(transactionId: string) {
  const tx = await db.walletTransaction.findUnique({
    where: { id: transactionId },
    include: {
      walletAccount: {
        include: {
          user: { select: { id: true, name: true, phone: true, email: true } },
        },
      },
      order: {
        select: {
          id: true,
          serviceType: true,
          status: true,
          total: true,
          priceFinal: true,
          address: true,
          createdAt: true,
        },
      },
    },
  });

  if (!tx) {
    throw new NotFoundError("WalletTransaction", transactionId);
  }

  return {
    receiptId: `REC-${tx.id.substring(0, 8).toUpperCase()}`,
    transactionId: tx.id,
    referenceId: tx.referenceId || `TX-${tx.id.substring(0, 10).toUpperCase()}`,
    status: tx.status,
    amount: Number(tx.amount),
    type: tx.type,
    preBalance: tx.preBalance !== null ? Number(tx.preBalance) : undefined,
    postBalance: tx.postBalance !== null ? Number(tx.postBalance) : undefined,
    senderName: tx.senderName || undefined,
    recipientName: tx.recipientName || undefined,
    description: tx.description,
    createdAt: tx.createdAt,
    accountHolder: tx.walletAccount.user,
    orderDetails: tx.order || undefined,
    verified: true,
  };
}

