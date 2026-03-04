// ─── Merchant Normalization & Spending Categorization ────────────────────────
// Maps raw merchant names from statements to clean names and categories.

// ─── Category Keywords ───────────────────────────────────────────────────────
// Each category has an array of keywords/patterns that match merchant names.

const CATEGORY_RULES = [
  {
    category: "Food & Dining",
    patterns: [
      /swiggy/i,
      /zomato/i,
      /uber\s*eats/i,
      /dominos/i,
      /pizza/i,
      /mcdonald/i,
      /starbucks/i,
      /cafe/i,
      /restaurant/i,
      /food/i,
      /dining/i,
      /biryani/i,
      /kitchen/i,
      /burger/i,
      /kfc/i,
      /subway/i,
      /barbeque/i,
      /magicpin/i,
      /eatsure/i,
      /box8/i,
      /faasos/i,
      /behrouz/i,
      /freshmenu/i,
    ],
  },
  {
    category: "Groceries",
    patterns: [
      /bigbasket/i,
      /blinkit/i,
      /grofers/i,
      /zepto/i,
      /dmart/i,
      /instamart/i,
      /jiomart/i,
      /grocery/i,
      /supermarket/i,
      /reliance\s*fresh/i,
      /spencer/i,
      /nature.*basket/i,
      /more\s*supermarket/i,
    ],
  },
  {
    category: "Shopping",
    patterns: [
      /amazon/i,
      /flipkart/i,
      /myntra/i,
      /ajio/i,
      /nykaa/i,
      /meesho/i,
      /tata\s*cliq/i,
      /shoppers\s*stop/i,
      /lifestyle/i,
      /westside/i,
      /h\s*&\s*m/i,
      /zara/i,
      /decathlon/i,
      /croma/i,
      /reliance\s*digital/i,
      /vijay\s*sales/i,
    ],
  },
  {
    category: "Transport",
    patterns: [
      /uber(?!\s*eat)/i,
      /ola\b/i,
      /rapido/i,
      /metro/i,
      /irctc/i,
      /fuel/i,
      /petrol/i,
      /diesel/i,
      /indian\s*oil/i,
      /bharat\s*petroleum/i,
      /hp\s*petrol/i,
      /shell/i,
      /parking/i,
      /fastag/i,
      /toll/i,
    ],
  },
  {
    category: "Travel",
    patterns: [
      /makemytrip/i,
      /goibibo/i,
      /cleartrip/i,
      /booking\.com/i,
      /airbnb/i,
      /oyo/i,
      /hotel/i,
      /airline/i,
      /indigo/i,
      /spicejet/i,
      /air\s*india/i,
      /vistara/i,
      /flight/i,
      /yatra/i,
    ],
  },
  {
    category: "Entertainment",
    patterns: [
      /netflix/i,
      /spotify/i,
      /amazon\s*prime/i,
      /hotstar/i,
      /disney/i,
      /youtube/i,
      /apple.*music/i,
      /sonyliv/i,
      /zee5/i,
      /jiocinema/i,
      /bookmyshow/i,
      /pvr/i,
      /inox/i,
      /cinema/i,
      /movie/i,
      /game/i,
      /playstation/i,
      /steam/i,
    ],
  },
  {
    category: "Utilities & Bills",
    patterns: [
      /electricity/i,
      /water\s*bill/i,
      /gas\s*bill/i,
      /broadband/i,
      /internet/i,
      /jio\b/i,
      /airtel/i,
      /vodafone/i,
      /vi\b/i,
      /bsnl/i,
      /recharge/i,
      /postpaid/i,
      /prepaid/i,
      /tata\s*power/i,
      /bescom/i,
      /mahanagar\s*gas/i,
      /piped\s*gas/i,
    ],
  },
  {
    category: "Health & Medical",
    patterns: [
      /pharmacy/i,
      /pharma/i,
      /medical/i,
      /hospital/i,
      /apollo/i,
      /1mg/i,
      /netmeds/i,
      /practo/i,
      /doctor/i,
      /clinic/i,
      /diagnostic/i,
      /lab\b/i,
      /dental/i,
      /eye\s*care/i,
      /lenskart/i,
    ],
  },
  {
    category: "Education",
    patterns: [
      /udemy/i,
      /coursera/i,
      /unacademy/i,
      /byjus/i,
      /school/i,
      /college/i,
      /university/i,
      /tuition/i,
      /education/i,
      /book/i,
      /kindle/i,
    ],
  },
  {
    category: "Insurance",
    patterns: [
      /insurance/i,
      /premium/i,
      /lic\b/i,
      /policy/i,
      /icici\s*lombard/i,
      /hdfc\s*ergo/i,
      /star\s*health/i,
      /bajaj\s*allianz/i,
    ],
  },
  {
    category: "EMI & Loans",
    patterns: [
      /emi\b/i,
      /loan/i,
      /instalment/i,
      /installment/i,
      /bajaj\s*finserv/i,
      /flexi\s*pay/i,
    ],
  },
  {
    category: "Transfers & Payments",
    patterns: [
      /neft/i,
      /imps/i,
      /upi/i,
      /rtgs/i,
      /paytm/i,
      /phonepe/i,
      /google\s*pay/i,
      /gpay/i,
      /bhim/i,
      /transfer/i,
    ],
  },
  {
    category: "Fees & Charges",
    patterns: [
      /annual\s*fee/i,
      /interest/i,
      /late\s*fee/i,
      /finance\s*charge/i,
      /service\s*charge/i,
      /gst/i,
      /tax\b/i,
      /surcharge/i,
      /convenience\s*fee/i,
    ],
  },
];

// ─── Merchant Name Normalization ─────────────────────────────────────────────
// Maps raw statement descriptions to clean merchant names.

const MERCHANT_MAP = {
  swiggy: "Swiggy",
  zomato: "Zomato",
  "uber eats": "Uber Eats",
  "ubereats": "Uber Eats",
  amazon: "Amazon",
  flipkart: "Flipkart",
  myntra: "Myntra",
  bigbasket: "BigBasket",
  blinkit: "Blinkit",
  zepto: "Zepto",
  netflix: "Netflix",
  spotify: "Spotify",
  uber: "Uber",
  ola: "Ola",
  rapido: "Rapido",
  makemytrip: "MakeMyTrip",
  "bookmyshow": "BookMyShow",
  starbucks: "Starbucks",
  dominos: "Domino's",
  "mcdonald": "McDonald's",
  kfc: "KFC",
  subway: "Subway",
  croma: "Croma",
  nykaa: "Nykaa",
  ajio: "AJIO",
  decathlon: "Decathlon",
  hotstar: "Disney+ Hotstar",
  "amazon prime": "Amazon Prime",
  irctc: "IRCTC",
  paytm: "Paytm",
  phonepe: "PhonePe",
  "google pay": "Google Pay",
  gpay: "Google Pay",
};

/**
 * Normalize a raw merchant name from the statement.
 * Returns a clean, consistent name.
 */
export function normalizeMerchant(raw) {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase().trim();

  // Check exact matches first
  for (const [key, cleanName] of Object.entries(MERCHANT_MAP)) {
    if (lower.includes(key)) {
      return cleanName;
    }
  }

  // Title-case the raw name as fallback
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Categorize a transaction based on merchant name / description.
 */
export function categorize(description) {
  if (!description) return "Uncategorized";
  
  for (const rule of CATEGORY_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(description)) {
        return rule.category;
      }
    }
  }
  return "Uncategorized";
}
