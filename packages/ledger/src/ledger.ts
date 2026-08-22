const SCALE = BigInt(18);
const UNIT = BigInt(10) ** SCALE;

type PostingSide = "debit" | "credit";

export type LedgerPostingInput = {
  side: PostingSide;
  amount: string;
};

function parseDecimalToUnits(value: string) {
  const raw = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(raw)) throw new Error("INVALID_DECIMAL_AMOUNT");
  const [integer, fraction = ""] = raw.split(".");
  return BigInt(integer) * UNIT + BigInt(fraction.padEnd(Number(SCALE), "0"));
}

function unitsToDecimal(units: bigint) {
  const integer = units / UNIT;
  const fraction = (units % UNIT).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

export function normalizeDecimalString(value: string) {
  return unitsToDecimal(parseDecimalToUnits(value));
}

export function addDecimalStrings(left: string, right: string) {
  return unitsToDecimal(parseDecimalToUnits(left) + parseDecimalToUnits(right));
}

export function compareDecimalStrings(left: string, right: string) {
  const a = parseDecimalToUnits(left);
  const b = parseDecimalToUnits(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

export function assertBalancedPostings(postings: LedgerPostingInput[]) {
  if (postings.length < 2) throw new Error("LEDGER_REQUIRES_MULTIPLE_POSTINGS");
  let debit = BigInt(0);
  let credit = BigInt(0);
  for (const posting of postings) {
    const amount = parseDecimalToUnits(posting.amount);
    if (amount <= BigInt(0)) throw new Error("LEDGER_AMOUNT_MUST_BE_POSITIVE");
    if (posting.side === "debit") debit += amount;
    else if (posting.side === "credit") credit += amount;
    else throw new Error("LEDGER_POSTING_SIDE_INVALID");
  }
  if (debit !== credit) throw new Error("LEDGER_NOT_BALANCED");
  return true;
}
