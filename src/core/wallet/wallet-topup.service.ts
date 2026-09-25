/**
 * Wallet Top-up Flow — Manual Proof of Transfer
 * 
 * Flow:
 *  1. User calls POST /api/wallet/topup/initiate
 *     → System returns platform payment numbers (Instapay / Vodafone Cash)
 *     → Creates a WalletTopupRequest in PENDING status
 *
 *  2. User actually sends money via their bank/mobile wallet app (outside platform)
 *
 *  3. User calls POST /api/wallet/topup/submit-proof
 *     → Submits: requestId, declaredAmount, proofImageUrl, proofText
 *     → AI reviews the proof and sets aiVerdict / aiConfidence
 *     → If AI confidence >= threshold → auto-approve and credit wallet
 *     → If AI is unsure → status = AI_FLAGGED (admin reviews manually)
 *
 *  4. Admin can always override via POST /api/admin/wallet/topup-requests/:id/approve|reject
 */

import { db } from "../../db.js";
import { AppError, NotFoundError } from "../errors/app-error.js";
import { credit } from "./wallet.service.js";
import { TransactionType } from "@prisma/client";
import { getConfig, getConfigNumber, CONFIG_KEYS } from "../config/system-config.service.js";
import { getOrCreateWallet } from "./wallet.service.js";

// ---------------------------------------------------------------------------
// Initiate Topup — Show platform payment info and create pending request
// ---------------------------------------------------------------------------
export async function initiateTopup(params: {
  userId: string;
  paymentMethod: "instapay" | "vodafone_cash" | "bank_transfer";
  declaredAmount: number;
}) {
  const { userId, paymentMethod, declaredAmount } = params;

  const [minAmount, maxAmount] = await Promise.all([
    getConfigNumber(CONFIG_KEYS.TOPUP_MIN_AMOUNT, 10),
    getConfigNumber(CONFIG_KEYS.TOPUP_MAX_AMOUNT, 50000),
  ]);

  if (declaredAmount < minAmount) {
    throw new AppError(`Minimum top-up amount is ${minAmount} EGP`, 400, "AMOUNT_TOO_LOW");
  }
  if (declaredAmount > maxAmount) {
    throw new AppError(`Maximum top-up amount is ${maxAmount} EGP`, 400, "AMOUNT_TOO_HIGH");
  }

  // Get platform account number for the chosen payment method
  let platformAccount = "";
  if (paymentMethod === "instapay") {
    platformAccount = await getConfig(CONFIG_KEYS.INSTAPAY_NUMBER);
  } else if (paymentMethod === "vodafone_cash") {
    platformAccount = await getConfig(CONFIG_KEYS.VODAFONE_CASH_NUMBER);
  } else {
    platformAccount = await getConfig(CONFIG_KEYS.BANK_TRANSFER_IBAN);
  }

  if (!platformAccount || platformAccount === "NOT_CONFIGURED") {
    throw new AppError(
      `Payment method '${paymentMethod}' is not configured on this platform. Please contact support.`,
      503,
      "PAYMENT_METHOD_NOT_CONFIGURED"
    );
  }

  const wallet = await getOrCreateWallet(userId);

  const topupRequest = await db.walletTopupRequest.create({
    data: {
      walletAccountId: wallet.id,
      paymentMethod,
      platformAccount,
      declaredAmount,
      status: "PENDING",
    },
  });

  return {
    success: true,
    message: `Transfer ${declaredAmount} EGP to the following ${paymentMethod} account, then submit your proof.`,
    topupRequest: {
      id: topupRequest.id,
      paymentMethod: topupRequest.paymentMethod,
      platformAccount: topupRequest.platformAccount,
      declaredAmount: Number(topupRequest.declaredAmount),
      status: topupRequest.status,
      createdAt: topupRequest.createdAt,
      instructions: buildInstructions(paymentMethod, platformAccount, declaredAmount),
    },
  };
}

function buildInstructions(method: string, account: string, amount: number): string {
  const steps: Record<string, string> = {
    instapay: `1. Open your banking app → InstaPay. 2. Send ${amount} EGP to account: ${account}. 3. Take a screenshot of the confirmation. 4. Come back and submit your proof.`,
    vodafone_cash: `1. Open Vodafone Cash app. 2. Transfer ${amount} EGP to number: ${account}. 3. Take a screenshot. 4. Submit the proof here.`,
    bank_transfer: `1. Go to your bank branch or online banking. 2. Wire ${amount} EGP to IBAN: ${account}. 3. Get the transfer receipt. 4. Upload it here.`,
  };
  return steps[method] || `Transfer ${amount} EGP to ${account} then submit your proof.`;
}

// ---------------------------------------------------------------------------
// Submit Proof — User provides screenshot URL + declared amount
// ---------------------------------------------------------------------------
export async function submitTopupProof(params: {
  userId: string;
  requestId: string;
  proofImageUrl?: string;
  proofText?: string;
}) {
  const { userId, requestId, proofImageUrl, proofText } = params;

  const wallet = await db.walletAccount.findUnique({ where: { userId } });
  if (!wallet) throw new NotFoundError("WalletAccount", userId);

  const topupRequest = await db.walletTopupRequest.findUnique({
    where: { id: requestId },
  });

  if (!topupRequest) throw new NotFoundError("WalletTopupRequest", requestId);
  if (topupRequest.walletAccountId !== wallet.id) {
    throw new AppError("This top-up request does not belong to your account", 403, "FORBIDDEN");
  }
  if (topupRequest.status !== "PENDING") {
    throw new AppError(
      `Cannot submit proof for request with status '${topupRequest.status}'`,
      400,
      "INVALID_STATUS"
    );
  }
  if (!proofImageUrl && !proofText) {
    throw new AppError("At least one of proofImageUrl or proofText is required", 400, "PROOF_REQUIRED");
  }

  // Run AI verification
  const aiResult = await verifyTopupProof({
    declaredAmount: Number(topupRequest.declaredAmount),
    paymentMethod: topupRequest.paymentMethod,
    platformAccount: topupRequest.platformAccount,
    proofImageUrl,
    proofText,
  });

  const threshold = await getConfigNumber(CONFIG_KEYS.TOPUP_AI_CONFIDENCE_THRESHOLD, 0.75);

  let newStatus: string;
  if (aiResult.verdict === "CONFIRMED" && aiResult.confidence >= threshold) {
    newStatus = "APPROVED";
  } else if (aiResult.verdict === "SUSPICIOUS") {
    newStatus = "AI_FLAGGED";
  } else {
    // Confidence below threshold → manual review
    newStatus = "AI_FLAGGED";
  }

  const updated = await db.walletTopupRequest.update({
    where: { id: requestId },
    data: {
      proofImageUrl,
      proofText,
      aiVerdict: aiResult.verdict,
      aiConfidence: aiResult.confidence,
      aiNotes: aiResult.notes,
      status: newStatus,
      ...(newStatus === "APPROVED" ? { reviewedAt: new Date(), creditedAt: new Date() } : {}),
    },
  });

  // Auto-credit if AI approved
  if (newStatus === "APPROVED") {
    await credit(
      wallet.id,
      Number(topupRequest.declaredAmount),
      TransactionType.topup,
      undefined,
      `Wallet top-up via ${topupRequest.paymentMethod} — AI verified [Request: ${requestId}]`,
      undefined,
      {
        referenceId: requestId,
        senderName: `${topupRequest.paymentMethod.toUpperCase()} Transfer`,
      }
    );

    return {
      success: true,
      status: "APPROVED",
      message: "Payment verified! Your wallet has been credited.",
      creditedAmount: Number(topupRequest.declaredAmount),
      aiVerdict: aiResult.verdict,
      aiConfidence: aiResult.confidence,
      request: updated,
    };
  }

  return {
    success: true,
    status: newStatus,
    message:
      newStatus === "AI_FLAGGED"
        ? "Your proof is under review. An admin will verify your transfer within 24 hours."
        : "Proof submitted. Awaiting verification.",
    aiVerdict: aiResult.verdict,
    aiConfidence: aiResult.confidence,
    aiNotes: aiResult.notes,
    request: updated,
  };
}

// ---------------------------------------------------------------------------
// AI Verification Logic
// Heuristic-based with scoring. Can be replaced with a real vision AI model.
// ---------------------------------------------------------------------------
interface AiVerificationResult {
  verdict: "CONFIRMED" | "SUSPICIOUS" | "MANUAL_REVIEW";
  confidence: number;  // 0.0 to 1.0
  notes: string;
}

export async function verifyTopupProof(params: {
  declaredAmount: number;
  paymentMethod: string;
  platformAccount: string;
  proofImageUrl?: string;
  proofText?: string;
}): Promise<AiVerificationResult> {
  const { declaredAmount, paymentMethod, platformAccount, proofImageUrl, proofText } = params;

  let score = 0.5; // baseline
  const signals: string[] = [];

  // Signal: Proof image provided
  if (proofImageUrl) {
    score += 0.15;
    signals.push("proof_image_provided");

    // Heuristic: Check if URL looks like a real upload (not a stock/placeholder URL)
    const isSuspiciousUrl =
      proofImageUrl.includes("placeholder") ||
      proofImageUrl.includes("example.com") ||
      proofImageUrl.includes("test.com") ||
      proofImageUrl.includes("fake");

    if (isSuspiciousUrl) {
      score -= 0.3;
      signals.push("suspicious_url_detected");
    } else {
      score += 0.05;
      signals.push("image_url_looks_valid");
    }
  }

  // Signal: Proof text provided
  if (proofText) {
    const normalizedText = proofText.toLowerCase();

    // Does the text mention the amount?
    const amountStr = declaredAmount.toString();
    if (proofText.includes(amountStr) || normalizedText.includes(`${declaredAmount}`)) {
      score += 0.15;
      signals.push("amount_mentioned_in_proof");
    }

    // Does the text mention the platform account?
    if (proofText.includes(platformAccount)) {
      score += 0.15;
      signals.push("platform_account_mentioned");
    }

    // Does it mention the payment method?
    if (
      normalizedText.includes(paymentMethod.replace("_", " ")) ||
      (paymentMethod === "instapay" && normalizedText.includes("instapay")) ||
      (paymentMethod === "vodafone_cash" && (normalizedText.includes("vodafone") || normalizedText.includes("فودافون")))
    ) {
      score += 0.1;
      signals.push("payment_method_mentioned");
    }

    // Red flags: suspicious phrases
    const suspiciousTerms = ["test", "fake", "demo", "بدون", "مفيش", "لأ"];
    if (suspiciousTerms.some((t) => normalizedText.includes(t))) {
      score -= 0.25;
      signals.push("suspicious_terms_detected");
    }

    // Minimum text length check
    if (proofText.trim().length < 10) {
      score -= 0.1;
      signals.push("proof_text_too_short");
    }
  }

  // Amount sanity checks
  if (declaredAmount < 1) {
    score = 0.1;
    signals.push("amount_too_low");
  } else if (declaredAmount > 100000) {
    score -= 0.2;
    signals.push("unusually_large_amount");
  }

  // Clamp score
  score = Math.max(0, Math.min(1, score));

  let verdict: AiVerificationResult["verdict"];
  if (score >= 0.75) {
    verdict = "CONFIRMED";
  } else if (score < 0.4) {
    verdict = "SUSPICIOUS";
  } else {
    verdict = "MANUAL_REVIEW";
  }

  return {
    verdict,
    confidence: Math.round(score * 100) / 100,
    notes: `AI signals: [${signals.join(", ")}]. Confidence: ${(score * 100).toFixed(0)}%. ${
      verdict === "SUSPICIOUS"
        ? "Manual admin review required — transfer not credited."
        : verdict === "MANUAL_REVIEW"
        ? "Confidence below auto-approval threshold. Queued for admin review."
        : "Transfer appears genuine. Auto-approved."
    }`,
  };
}

// ---------------------------------------------------------------------------
// Get User's Topup Request History
// ---------------------------------------------------------------------------
export async function getTopupHistory(userId: string) {
  const wallet = await db.walletAccount.findUnique({ where: { userId } });
  if (!wallet) throw new NotFoundError("WalletAccount", userId);

  return db.walletTopupRequest.findMany({
    where: { walletAccountId: wallet.id },
    orderBy: { createdAt: "desc" },
  });
}
