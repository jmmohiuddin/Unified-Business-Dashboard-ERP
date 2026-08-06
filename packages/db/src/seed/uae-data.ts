/**
 * Dubai reference data for the demo dataset.
 *
 * Realism matters here beyond cosmetics: the customer-name mix, the price
 * levels and the rent structure are what make the dashboard numbers behave the
 * way a Dubai owner expects. A seed full of Western names and USD prices would
 * quietly hide whether the formatting, the VAT treatment or the cheque cycle
 * were right.
 */

/** Dubai residential and commercial areas, weighted toward mid-market. */
export const DUBAI_AREAS = [
  "Al Barsha", "Business Bay", "Jumeirah Village Circle", "Dubai Marina",
  "Deira", "Bur Dubai", "Al Karama", "Al Quoz", "Mirdif", "Dubai Silicon Oasis",
  "Discovery Gardens", "Al Nahda", "International City", "Jumeirah Lakes Towers",
  "Dubai Sports City", "Al Warqa", "Oud Metha", "Satwa",
] as const;

/**
 * Customer names reflecting Dubai's actual population mix. Roughly: South Asian
 * ~55%, Arab expat + Emirati ~20%, Filipino ~10%, Western ~8%, other ~7%.
 * A men's salon in Al Barsha serves exactly this spread.
 */
export const NAMES = {
  emirati: [
    "Ahmed Al Mansoori", "Khalid Al Suwaidi", "Fatima Al Hammadi", "Mariam Al Balushi",
    "Omar Al Marzooqi", "Saeed Al Ketbi", "Noura Al Shamsi", "Hamdan Al Falasi",
  ],
  arabExpat: [
    "Mohamed Hassan", "Rania Fawzy", "Karim Nabil", "Layla Haddad",
    "Tarek Mansour", "Hala Khoury", "Youssef Barakat", "Dina Aoun",
    "Bassam Haidar", "Nour Zeidan", "Wael Abdelrahman", "Samar Nassar",
  ],
  southAsian: [
    "Rajesh Nair", "Priya Menon", "Vikram Sharma", "Anjali Pillai",
    "Suresh Kumar", "Deepak Iyer", "Kavita Rao", "Arun Krishnan",
    "Imran Malik", "Ayesha Siddiqui", "Bilal Chaudhry", "Saima Khan",
    "Usman Raza", "Farah Qureshi", "Sunil Verma", "Meera Joshi",
    "Rahul Bhatia", "Sneha Kulkarni", "Tariq Javed", "Nadia Aslam",
    "Ravi Subramaniam", "Pooja Desai", "Asif Mahmood", "Zainab Hussain",
  ],
  filipino: [
    "Maria Santos", "Jomar Reyes", "Angelica Cruz", "Rommel Dela Cruz",
    "Grace Bautista", "Michael Ramos", "Kristine Villanueva", "Carlo Aquino",
  ],
  western: [
    "James Whitfield", "Sarah Bennett", "Michael O'Connor", "Emma Clarke",
    "David Thompson", "Rachel Fitzgerald",
  ],
  other: [
    "Daniel Okonkwo", "Amina Yusuf", "Sergey Volkov", "Elena Petrova",
    "Chen Wei", "Mustafa Yilmaz",
  ],
} as const;

/** Weighted so the mix looks like a real Dubai customer book. */
export const NAME_POOL: readonly (readonly [readonly string[], number])[] = [
  [NAMES.southAsian, 55],
  [NAMES.arabExpat, 14],
  [NAMES.emirati, 6],
  [NAMES.filipino, 10],
  [NAMES.western, 8],
  [NAMES.other, 7],
];

export const NATIONALITIES = [
  "India", "Pakistan", "Philippines", "Egypt", "Bangladesh", "Syria",
  "Jordan", "Lebanon", "United Kingdom", "Nepal", "Sri Lanka", "Sudan",
] as const;

export const UAE_BANKS = [
  "Emirates NBD", "First Abu Dhabi Bank", "Abu Dhabi Commercial Bank",
  "Mashreq Bank", "Dubai Islamic Bank", "Emirates Islamic", "RAKBANK",
  "Commercial Bank of Dubai", "Ajman Bank", "HSBC UAE",
] as const;

/** MOHRE routing codes are bank-specific; these are plausible placeholders. */
export const BANK_ROUTING: Record<string, string> = {
  "Emirates NBD": "402010101",
  "First Abu Dhabi Bank": "402030103",
  "Abu Dhabi Commercial Bank": "402050105",
  "Mashreq Bank": "402070107",
  "Dubai Islamic Bank": "402090109",
  "Emirates Islamic": "402110111",
  RAKBANK: "402130113",
  "Commercial Bank of Dubai": "402150115",
  "Ajman Bank": "402170117",
  "HSBC UAE": "402190119",
};

export const COURIERS = ["Aramex", "Fetchr", "Emirates Post", "Careem Express", "Talabat"] as const;

export const ECOM_CHANNELS = ["noon.com", "Amazon.ae", "Instagram Shop", "Own website"] as const;

/**
 * Dubai price levels in AED, mid-market.
 *
 * These are the numbers that decide whether the dashboard "feels" right. A
 * gents' haircut at AED 60 in Al Barsha, an AC service call at AED 180, a 1-bed
 * in JVC at AED 60k a year — get these wrong and every derived figure, from
 * margin to cash forecast, reads as fiction.
 */
export const SALON_SERVICES: [string, number, number, string][] = [
  // name, price AED, minutes, skill
  ["Gents Haircut", 60, 30, "haircut"],
  ["Beard Trim & Shape", 40, 20, "beard"],
  ["Haircut + Beard", 90, 45, "haircut"],
  ["Hair Colour", 180, 90, "colour"],
  ["Head & Shoulder Massage", 70, 30, "haircut"],
  ["Facial Clean-up", 150, 60, "facial"],
  ["Kids Haircut", 45, 25, "haircut"],
  ["Hair Spa Treatment", 200, 75, "colour"],
  ["Moroccan Bath", 250, 60, "facial"],
];

export const PHONES: [string, number, number][] = [
  // name, retail AED, cost AED
  ["Samsung Galaxy A55 128GB", 1299, 1085],
  ["Samsung Galaxy A35 128GB", 999, 830],
  ["Samsung Galaxy S24 FE 256GB", 2199, 1920],
  ["Xiaomi Redmi Note 14 256GB", 849, 690],
  ["Xiaomi Redmi 14C 128GB", 429, 340],
  ["Realme C65 128GB", 479, 385],
  ["Infinix Hot 50 256GB", 549, 435],
  ["vivo Y28 128GB", 599, 480],
  ["Honor X9b 256GB", 1099, 915],
];

export const ACCESSORIES: [string, number, number][] = [
  ["Tempered Glass Protector", 35, 8],
  ["Silicone Phone Case", 49, 14],
  ["65W Fast Charger", 129, 78],
  ["USB-C Cable 1m", 39, 11],
  ["Bluetooth Earbuds", 199, 118],
  ["Power Bank 20000mAh", 229, 148],
  ["Memory Card 128GB", 99, 62],
  ["Car Phone Mount", 59, 22],
];

export const ONLINE_ITEMS: [string, number, number][] = [
  ["Wireless Mouse", 89, 52],
  ["Mechanical Keyboard", 349, 235],
  ["Laptop Stand (Aluminium)", 149, 88],
  ["1080p Webcam", 249, 165],
  ["USB-C Hub 6-in-1", 179, 108],
  ["LED Desk Lamp", 129, 74],
  ["Monitor Arm", 299, 195],
];

/** Field-service catalogue. Dubai callout rates, mid-market contractor. */
export const TECH_SERVICES: [string, number, string, number][] = [
  // name, price AED, service kind, minutes
  ["AC Servicing (Split Unit)", 180, "ac_service", 90],
  ["AC Gas Refill (R410)", 380, "ac_service", 120],
  ["AC Installation", 550, "ac_service", 180],
  ["AC Duct Cleaning", 450, "ac_service", 150],
  ["Pipe Leak Repair", 220, "plumbing", 60],
  ["Bathroom Fixture Fitting", 380, "plumbing", 150],
  ["Water Heater Replacement", 450, "plumbing", 120],
  ["Electrical Wiring Repair", 250, "electrical", 90],
  ["Switchboard / DB Replacement", 420, "electrical", 120],
  ["Light Fitting Installation", 150, "electrical", 45],
  ["Furniture Assembly", 180, "handyman", 60],
  ["Curtain & Blind Fitting", 200, "handyman", 75],
  ["Deep Cleaning (2BR Apartment)", 550, "cleaning", 240],
  ["Regular Cleaning (4 hours)", 180, "cleaning", 240],
  ["Move-in / Move-out Cleaning", 700, "cleaning", 300],
];

export const MATERIALS: [string, number, number][] = [
  ["R410A Refrigerant Gas (kg)", 95, 62],
  ["PVC Pipe 1in (metre)", 18, 11],
  ["Copper Wire 2.5mm (metre)", 9, 5.5],
  ["Switch Socket (British std)", 32, 18],
  ["Cement Bag 50kg", 16, 12],
  ["Steel Rebar 12mm (kg)", 4.2, 3.4],
  ["Gypsum Board Sheet", 38, 27],
  ["Emulsion Paint 18L", 210, 148],
];

export const SUPPLIERS = [
  "Jumbo Electronics LLC",
  "Xiaomi Distribution Middle East",
  "Al Nahda Beauty Supplies",
  "Danube Building Materials",
  "Al Quoz Electrical Trading",
  "Cool Tech Refrigeration Supplies",
  "Ducab Cable Distributors",
  "Emirates Cement Trading",
] as const;

/**
 * Staff. Salary in AED per month, split into the components UAE law and
 * gratuity calculation require — gratuity is on BASIC only.
 */
export interface StaffSeed {
  code: string;
  name: string;
  bu: string;
  role: string;
  total: number;
  field: boolean;
  skills: string[];
  nationality: string;
  /** Years of service — drives the gratuity liability, which is the point. */
  yearsService: number;
}

export const STAFF: StaffSeed[] = [
  { code: "E001", name: "Imran Malik", bu: "SALON", role: "Senior Barber", total: 4500, field: false, skills: ["haircut", "beard", "colour"], nationality: "Pakistan", yearsService: 6.5 },
  { code: "E002", name: "Jomar Reyes", bu: "SALON", role: "Barber", total: 3500, field: false, skills: ["haircut", "beard"], nationality: "Philippines", yearsService: 3.2 },
  { code: "E003", name: "Arun Krishnan", bu: "SALON", role: "Barber", total: 3200, field: false, skills: ["haircut"], nationality: "India", yearsService: 1.4 },
  { code: "E004", name: "Tarek Mansour", bu: "SALON", role: "Salon Manager", total: 8000, field: false, skills: [], nationality: "Egypt", yearsService: 4.8 },
  { code: "E005", name: "Angelica Cruz", bu: "MOBILE", role: "Sales Executive", total: 5000, field: false, skills: [], nationality: "Philippines", yearsService: 2.6 },
  { code: "E006", name: "Bilal Chaudhry", bu: "MOBILE", role: "Sales Executive", total: 4500, field: false, skills: [], nationality: "Pakistan", yearsService: 0.7 },
  { code: "E007", name: "Suresh Kumar", bu: "TECH", role: "Senior AC Technician", total: 4200, field: true, skills: ["ac_service", "electrical"], nationality: "India", yearsService: 8.1 },
  { code: "E008", name: "Asif Mahmood", bu: "TECH", role: "Plumber", total: 3500, field: true, skills: ["plumbing", "handyman"], nationality: "Pakistan", yearsService: 5.3 },
  { code: "E009", name: "Ravi Subramaniam", bu: "TECH", role: "Electrician", total: 4000, field: true, skills: ["electrical", "handyman"], nationality: "India", yearsService: 3.9 },
  { code: "E010", name: "Grace Bautista", bu: "TECH", role: "Cleaning Supervisor", total: 3000, field: true, skills: ["cleaning"], nationality: "Philippines", yearsService: 2.1 },
  { code: "E011", name: "Mohamed Hassan", bu: "BUILD", role: "Site Engineer", total: 14000, field: true, skills: ["construction"], nationality: "Egypt", yearsService: 5.9 },
  { code: "E012", name: "Rajesh Nair", bu: "PROP", role: "Property Manager", total: 9000, field: false, skills: [], nationality: "India", yearsService: 7.2 },
  { code: "E013", name: "Daniel Okonkwo", bu: "PARK", role: "Parking Attendant", total: 2800, field: false, skills: [], nationality: "Sudan", yearsService: 1.8 },
  { code: "E014", name: "Rafiq Ahmed", bu: "SALON", role: "Group Accountant", total: 10000, field: false, skills: [], nationality: "Bangladesh", yearsService: 4.1 },
];

/**
 * Standard UAE package split. Gratuity is calculated on basic only, so the
 * split has direct financial consequence — employers commonly set basic at
 * 50–60% of package precisely to contain the gratuity liability.
 */
export const SALARY_SPLIT = { basic: 0.6, housing: 0.25, transport: 0.1, other: 0.05 };

export function splitSalary(total: number) {
  return {
    basic: Math.round(total * SALARY_SPLIT.basic),
    housing: Math.round(total * SALARY_SPLIT.housing),
    transport: Math.round(total * SALARY_SPLIT.transport),
    other: Math.round(total * SALARY_SPLIT.other),
  };
}

/** Monthly operating costs in AED: [businessCode, accountKey, min, max]. */
export const OPERATING_COSTS: [string, string, number, number][] = [
  ["SALON", "RENT_EXPENSE", 12000, 12000],
  ["MOBILE", "RENT_EXPENSE", 18000, 18000],
  ["TECH", "RENT_EXPENSE", 8000, 8000],
  ["BUILD", "RENT_EXPENSE", 6000, 6000],
  ["SALON", "UTILITIES", 2400, 4200],
  ["MOBILE", "UTILITIES", 1600, 2800],
  ["PROP", "UTILITIES", 5500, 9500],
  ["PARK", "UTILITIES", 800, 1600],
  ["ONLINE", "MARKETING", 3500, 12000],
  ["SALON", "MARKETING", 700, 3000],
  ["TECH", "TRANSPORT", 3200, 6000],
  ["BUILD", "TRANSPORT", 5500, 13000],
  ["PROP", "REPAIRS", 1200, 7500],
  ["MOBILE", "BANK_CHARGES", 600, 1400],
];
