import { PrismaClient, ServiceType, VehicleType } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

async function main() {
  console.log("Starting MoveX seed...");

  // 1. Roles
  const roleNames = ["customer", "driver", "worker", "partner", "admin", "supervisor"];
  const roles: Record<string, any> = {};
  for (const name of roleNames) {
    roles[name] = await db.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }
  console.log("Seeded roles");

  // 2. Permissions
  const permissionKeys = [
    "order.create",
    "order.cancel",
    "order.view",
    "bidding.offer",
    "bidding.accept",
    "wallet.view",
    "wallet.payout.approve",
    "kyc.review",
    "admin.view",
    "admin.manage",
  ];
  const permissions: Record<string, any> = {};
  for (const key of permissionKeys) {
    permissions[key] = await db.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
  }
  console.log("Seeded permissions");

  // 3. RolePermission mappings
  const rolePermissions: Record<string, string[]> = {
    customer: ["order.create", "order.cancel", "order.view", "bidding.accept", "wallet.view"],
    driver: ["order.view", "bidding.offer", "wallet.view"],
    worker: ["order.view", "bidding.offer", "wallet.view"],
    partner: ["order.view", "wallet.view"],
    supervisor: ["order.view", "kyc.review", "admin.view"],
    admin: permissionKeys,
  };

  for (const [roleName, pKeys] of Object.entries(rolePermissions)) {
    const role = roles[roleName];
    for (const pKey of pKeys) {
      const perm = permissions[pKey];
      await db.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: perm.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: perm.id,
        },
      });
    }
  }
  console.log("Seeded role permissions");

  // 4. Service Categories Hierarchy Tree
  const foodCat = await db.serviceCategory.upsert({
    where: { id: "cat-food" },
    update: { name: "Food" },
    create: { id: "cat-food", name: "Food" },
  });

  const rideCat = await db.serviceCategory.upsert({
    where: { id: "cat-ride" },
    update: { name: "Ride" },
    create: { id: "cat-ride", name: "Ride" },
  });

  const handymanCat = await db.serviceCategory.upsert({
    where: { id: "cat-handyman" },
    update: { name: "Handyman" },
    create: { id: "cat-handyman", name: "Handyman" },
  });

  const plumbingCat = await db.serviceCategory.upsert({
    where: { id: "cat-plumbing" },
    update: { name: "Plumbing", parentId: handymanCat.id },
    create: { id: "cat-plumbing", name: "Plumbing", parentId: handymanCat.id },
  });

  const electricalCat = await db.serviceCategory.upsert({
    where: { id: "cat-electrical" },
    update: { name: "Electrical", parentId: handymanCat.id },
    create: { id: "cat-electrical", name: "Electrical", parentId: handymanCat.id },
  });

  const carpentryCat = await db.serviceCategory.upsert({
    where: { id: "cat-carpentry" },
    update: { name: "Carpentry", parentId: handymanCat.id },
    create: { id: "cat-carpentry", name: "Carpentry", parentId: handymanCat.id },
  });

  const movingCat = await db.serviceCategory.upsert({
    where: { id: "cat-moving" },
    update: { name: "Moving" },
    create: { id: "cat-moving", name: "Moving" },
  });
  console.log("Seeded ServiceCategories tree");

  // 5. Commission Rules
  const commissionRules = [
    { serviceType: ServiceType.food, percentage: 15.0 },
    { serviceType: ServiceType.ride, percentage: 20.0 },
    { serviceType: ServiceType.handyman, percentage: 10.0 },
    { serviceType: ServiceType.moving, percentage: 12.0 },
  ];
  for (const rule of commissionRules) {
    await db.commissionRule.upsert({
      where: { serviceType: rule.serviceType },
      update: { percentage: rule.percentage },
      create: rule,
    });
  }
  console.log("Seeded CommissionRules");

  // 6. Test Users (3 per role = 18 users) + default password
  const passwordHash = await bcrypt.hash("Password123!", 10);

  async function createTestUser(
    name: string,
    phone: string,
    email: string,
    roleName: string,
    balance: number = 500
  ) {
    const user = await db.user.upsert({
      where: { phone },
      update: { name, email, role: roleName.toUpperCase() },
      create: {
        name,
        phone,
        email,
        password: passwordHash,
        role: roleName.toUpperCase(),
      },
    });

    const role = roles[roleName];
    await db.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });

    await db.walletAccount.upsert({
      where: { userId: user.id },
      update: { balance },
      create: { userId: user.id, balance, currency: "EGP" },
    });

    return user;
  }

  // Customers
  const customer1 = await createTestUser("Customer One", "01000000001", "customer1@movex.com", "customer", 1000);
  const customer2 = await createTestUser("Customer Two", "01000000002", "customer2@movex.com", "customer", 1000);
  const customer3 = await createTestUser("Customer Three", "01000000003", "customer3@movex.com", "customer", 1000);

  // Drivers
  const driver1 = await createTestUser("Driver Sedan", "01000000011", "driver1@movex.com", "driver");
  const driver2 = await createTestUser("Driver Pickup", "01000000012", "driver2@movex.com", "driver");
  const driver3 = await createTestUser("Driver Van", "01000000013", "driver3@movex.com", "driver");

  // Workers
  const worker1 = await createTestUser("Plumber Bob", "01000000021", "worker1@movex.com", "worker");
  const worker2 = await createTestUser("Electrician Alice", "01000000022", "worker2@movex.com", "worker");
  const worker3 = await createTestUser("Carpenter Dan", "01000000023", "worker3@movex.com", "worker");

  // Partners (Restaurant owners)
  const partner1 = await createTestUser("Partner Burger", "01000000031", "partner1@movex.com", "partner");
  const partner2 = await createTestUser("Partner Pizza", "01000000032", "partner2@movex.com", "partner");
  const partner3 = await createTestUser("Partner Shawarma", "01000000033", "partner3@movex.com", "partner");

  // Admins
  const admin1 = await createTestUser("Admin Main", "01000000041", "admin1@movex.com", "admin");
  const admin2 = await createTestUser("Admin Ops", "01000000042", "admin2@movex.com", "admin");
  const admin3 = await createTestUser("Admin Support", "01000000043", "admin3@movex.com", "admin");

  // Supervisors
  const supervisor1 = await createTestUser("Supervisor North", "01000000051", "supervisor1@movex.com", "supervisor");
  const supervisor2 = await createTestUser("Supervisor South", "01000000052", "supervisor2@movex.com", "supervisor");
  const supervisor3 = await createTestUser("Supervisor Central", "01000000053", "supervisor3@movex.com", "supervisor");

  // Legacy Admin user (for backward compatibility)
  const legacyAdminPass = await bcrypt.hash("Admin12345!", 12);
  const legacyAdmin = await db.user.upsert({
    where: { phone: "01000000000" },
    update: {},
    create: { name: "Admin", phone: "01000000000", password: legacyAdminPass, role: "ADMIN" },
  });
  await db.userRole.upsert({
    where: { userId_roleId: { userId: legacyAdmin.id, roleId: roles["admin"].id } },
    update: {},
    create: { userId: legacyAdmin.id, roleId: roles["admin"].id },
  });
  await db.walletAccount.upsert({
    where: { userId: legacyAdmin.id },
    update: {},
    create: { userId: legacyAdmin.id, balance: 10000, currency: "EGP" },
  });

  console.log("Seeded 18 test users + legacy admin");

  // 7. Providers with mixed vehicleType and serviceCategories (5 providers)
  // Driver 1: Sedan -> Ride
  const profile1 = await db.providerProfile.upsert({
    where: { userId: driver1.id },
    update: { vehicleType: VehicleType.sedan, isAvailable: true, currentLat: 30.0444, currentLng: 31.2357 },
    create: { userId: driver1.id, vehicleType: VehicleType.sedan, isAvailable: true, currentLat: 30.0444, currentLng: 31.2357 },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile1.id, serviceCategoryId: rideCat.id } },
    update: {},
    create: { providerProfileId: profile1.id, serviceCategoryId: rideCat.id },
  });

  // Driver 2: Pickup -> Ride + Moving
  const profile2 = await db.providerProfile.upsert({
    where: { userId: driver2.id },
    update: { vehicleType: VehicleType.pickup, isAvailable: true, currentLat: 30.0445, currentLng: 31.2358 },
    create: { userId: driver2.id, vehicleType: VehicleType.pickup, isAvailable: true, currentLat: 30.0445, currentLng: 31.2358 },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile2.id, serviceCategoryId: rideCat.id } },
    update: {},
    create: { providerProfileId: profile2.id, serviceCategoryId: rideCat.id },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile2.id, serviceCategoryId: movingCat.id } },
    update: {},
    create: { providerProfileId: profile2.id, serviceCategoryId: movingCat.id },
  });

  // Driver 3: Van -> Moving
  const profile3 = await db.providerProfile.upsert({
    where: { userId: driver3.id },
    update: { vehicleType: VehicleType.van, isAvailable: true, currentLat: 30.0450, currentLng: 31.2360 },
    create: { userId: driver3.id, vehicleType: VehicleType.van, isAvailable: true, currentLat: 30.0450, currentLng: 31.2360 },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile3.id, serviceCategoryId: movingCat.id } },
    update: {},
    create: { providerProfileId: profile3.id, serviceCategoryId: movingCat.id },
  });

  // Special Provider: Large Truck -> Moving only
  const truckDriver = await createTestUser("Driver Heavy Truck", "01000000014", "truck@movex.com", "driver");
  const profile4 = await db.providerProfile.upsert({
    where: { userId: truckDriver.id },
    update: { vehicleType: VehicleType.large_truck, isAvailable: true, currentLat: 30.0460, currentLng: 31.2370 },
    create: { userId: truckDriver.id, vehicleType: VehicleType.large_truck, isAvailable: true, currentLat: 30.0460, currentLng: 31.2370 },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile4.id, serviceCategoryId: movingCat.id } },
    update: {},
    create: { providerProfileId: profile4.id, serviceCategoryId: movingCat.id },
  });

  // Worker 1: Handyman (Plumbing & Electrical) -> No vehicle
  const profile5 = await db.providerProfile.upsert({
    where: { userId: worker1.id },
    update: { vehicleType: null, isAvailable: true, currentLat: 30.0440, currentLng: 31.2350 },
    create: { userId: worker1.id, vehicleType: null, isAvailable: true, currentLat: 30.0440, currentLng: 31.2350 },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile5.id, serviceCategoryId: plumbingCat.id } },
    update: {},
    create: { providerProfileId: profile5.id, serviceCategoryId: plumbingCat.id },
  });
  await db.providerServiceCategory.upsert({
    where: { providerProfileId_serviceCategoryId: { providerProfileId: profile5.id, serviceCategoryId: electricalCat.id } },
    update: {},
    create: { providerProfileId: profile5.id, serviceCategoryId: electricalCat.id },
  });
  console.log("Seeded 5 ProviderProfiles with mixed vehicleTypes and categories");

  // 8. 3 Vendors with Menu Items
  // Vendor 1: Burger King
  const vendor1 = await db.vendor.upsert({
    where: { id: "vendor-burger-king" },
    update: { name: "Burger King", address: "123 Nile Corniche, Cairo", isOpen: true },
    create: {
      id: "vendor-burger-king",
      ownerUserId: partner1.id,
      name: "Burger King",
      categoryId: foodCat.id,
      address: "123 Nile Corniche, Cairo",
      isOpen: true,
    },
  });
  await db.menuItem.deleteMany({ where: { vendorId: vendor1.id } });
  await db.menuItem.createMany({
    data: [
      { vendorId: vendor1.id, name: "Double Whopper Burger", price: 12.00, isAvailable: true },
      { vendorId: vendor1.id, name: "Crispy Chicken Meal", price: 9.00, isAvailable: true },
      { vendorId: vendor1.id, name: "King French Fries", price: 3.50, isAvailable: true },
    ],
  });

  // Vendor 2: Pizza Palace
  const vendor2 = await db.vendor.upsert({
    where: { id: "vendor-pizza-palace" },
    update: { name: "Pizza Palace", address: "45 Tahrir Sq, Cairo", isOpen: true },
    create: {
      id: "vendor-pizza-palace",
      ownerUserId: partner2.id,
      name: "Pizza Palace",
      categoryId: foodCat.id,
      address: "45 Tahrir Sq, Cairo",
      isOpen: true,
    },
  });
  await db.menuItem.deleteMany({ where: { vendorId: vendor2.id } });
  await db.menuItem.createMany({
    data: [
      { vendorId: vendor2.id, name: "Margherita Supreme", price: 10.00, isAvailable: true },
      { vendorId: vendor2.id, name: "Pepperoni Passion", price: 14.00, isAvailable: true },
      { vendorId: vendor2.id, name: "Garlic Bread with Cheese", price: 4.00, isAvailable: true },
    ],
  });

  // Vendor 3: Shawarma Express
  const vendor3 = await db.vendor.upsert({
    where: { id: "vendor-shawarma-express" },
    update: { name: "Shawarma Express", address: "88 Zamalek St, Cairo", isOpen: true },
    create: {
      id: "vendor-shawarma-express",
      ownerUserId: partner3.id,
      name: "Shawarma Express",
      categoryId: foodCat.id,
      address: "88 Zamalek St, Cairo",
      isOpen: true,
    },
  });
  await db.menuItem.deleteMany({ where: { vendorId: vendor3.id } });
  await db.menuItem.createMany({
    data: [
      { vendorId: vendor3.id, name: "Chicken Shawarma Plate", price: 6.50, isAvailable: true },
      { vendorId: vendor3.id, name: "Beef Shawarma Sandwich", price: 7.50, isAvailable: true },
      { vendorId: vendor3.id, name: "Tahini & Pickles Combo", price: 2.50, isAvailable: true },
    ],
  });
  console.log("Seeded 3 Vendors with MenuItems");

  // 9. Legacy categories, products, and ads
  for (const name of ["Restaurants", "Supermarkets", "Desserts", "Stores"]) {
    const cat = await db.category.upsert({
      where: { name },
      update: { active: true },
      create: { name },
    });

    const products = [
      { name: `${name} - Item 1`, price: 50 },
      { name: `${name} - Item 2`, price: 75 },
    ];

    for (const product of products) {
      const existing = await db.product.findFirst({
        where: { name: product.name, categoryId: cat.id },
      });
      if (!existing) {
        await db.product.create({
          data: {
            name: product.name,
            description: "Sample Product",
            price: product.price,
            categoryId: cat.id,
            vendorId: vendor1.id,
          },
        });
      }
    }
  }

  const ads = [
    { type: "BANNER" as const, placement: "HOME", frequency: 1 },
    { type: "INTERSTITIAL" as const, placement: "AFTER_ORDER", frequency: 3 },
  ];

  for (const ad of ads) {
    const existing = await db.adConfig.findFirst({
      where: { type: ad.type, placement: ad.placement },
    });
    if (!existing) await db.adConfig.create({ data: ad });
  }

  console.log("MoveX Seed finished successfully!");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
