// Conversation state + deterministic validation.
// The LLM extracts values; this file decides whether they are acceptable.

export type Purpose =
  | "emi_query"
  | "payment_plan"
  | "new_loan"
  | "talk_to_agent"
  | "other";

export const PURPOSES: Purpose[] = [
  "emi_query",
  "payment_plan",
  "new_loan",
  "talk_to_agent",
  "other",
];

export const PURPOSE_LABEL: Record<Purpose, string> = {
  emi_query: "EMI query",
  payment_plan: "Payment arrangement",
  new_loan: "New loan enquiry",
  talk_to_agent: "Speak to an agent",
  other: "Other enquiry",
};

export type Field = "name" | "phone" | "email" | "date" | "time";
type ConfirmField = "phone" | "email";

export interface Booking {
  status: "booked" | "calendar_unavailable" | "calendar_error";
  eventId?: string;
  eventLink?: string;
}

export interface BotState {
  name?: string;
  phone?: string;
  email?: string;
  purpose?: Purpose;
  details: Record<string, string>;
  detailsComplete: boolean;
  date?: string; // YYYY-MM-DD (IST)
  time?: string; // HH:MM 24h (IST)
  /** Values that passed validation but still need the caller's "yes". */
  pending: { field: ConfirmField; value: string }[];
  /** Last rejected value per field, so the caller can correct it. */
  lastAttempt: Partial<Record<Field, string>>;
  attempts: Record<string, number>;
  booking?: Booking;
}

export interface Extracted {
  name?: string;
  phone?: string;
  email?: string;
  purpose?: Purpose;
  details?: Record<string, string>;
  details_complete?: boolean;
  date?: string;
  time?: string;
  confirmation?: "yes" | "no";
}

export const emptyState = (): BotState => ({
  details: {},
  detailsComplete: false,
  pending: [],
  lastAttempt: {},
  attempts: {},
});

/* ---------------- time helpers (IST) ---------------- */

const IST = "Asia/Kolkata";

export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
}

export function nowHHMM(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function nowISTLabel(): string {
  return new Date().toLocaleString("en-IN", {
    timeZone: IST,
    dateStyle: "full",
    timeStyle: "short",
  });
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const MAX_DAYS_AHEAD = 30;
export const FIRST_SLOT = "08:00";
export const LAST_SLOT = "20:30";

/* ---------------- normalisers ---------------- */

export function cleanPhone(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

export function phoneReadback(p: string): string {
  // "9641325001" -> "9 6 4 1 3, 2 5 0 0 1"
  return `${p.slice(0, 5).split("").join(" ")}, ${p.slice(5).split("").join(" ")}`;
}

export function emailReadback(e: string): string {
  const [local, domain = ""] = e.split("@");
  const spell = local
    .split("")
    .map((c) => (c === "." ? "dot" : c === "_" ? "underscore" : c === "-" ? "dash" : c))
    .join(" ");
  return `${spell} at ${domain.replace(/\./g, " dot ")}`;
}

/* ---------------- validators ---------------- */

export function validateField(f: Field, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = String(raw).trim();
  switch (f) {
    case "name":
      return /^[\p{L} .'-]{2,60}$/u.test(v)
        ? { ok: true, value: v.replace(/\s+/g, " ") }
        : { ok: false, error: "doesn't look like a valid name" };
    case "phone": {
      const d = cleanPhone(v);
      if (/^[6-9]\d{9}$/.test(d)) return { ok: true, value: d };
      return {
        ok: false,
        error: `has ${d.length} digits; an Indian mobile number needs exactly 10 digits starting with 6, 7, 8 or 9`,
      };
    }
    case "email": {
      const e = v.toLowerCase().replace(/\s+/g, "");
      if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return { ok: true, value: e };
      if (/^[^\s@]+@[^\s@.]+$/.test(e))
        return { ok: false, error: `is missing the domain ending (for example ".com" or ".in"); ask which one, don't assume` };
      return { ok: false, error: "is not a valid email address" };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: "could not be understood as a date" };
      const today = todayIST();
      if (v < today) return { ok: false, error: "is in the past" };
      if (v > addDays(today, MAX_DAYS_AHEAD)) {
        // Common slip: wrong year. Suggest the same day/month within range.
        const md = v.slice(5);
        const thisYear = `${today.slice(0, 4)}-${md}`;
        const nextYear = `${Number(today.slice(0, 4)) + 1}-${md}`;
        const guess = [thisYear, nextYear].find(
          (g) => g >= today && g <= addDays(today, MAX_DAYS_AHEAD),
        );
        return {
          ok: false,
          error: `is more than ${MAX_DAYS_AHEAD} days away${guess ? `; ask if they meant ${prettyDate(guess)} (${guess})` : ""}`,
        };
      }
      return { ok: true, value: v };
    }
    case "time": {
      if (!/^\d{1,2}:\d{2}$/.test(v)) return { ok: false, error: "could not be understood as a time" };
      const [h, m] = v.split(":").map(Number);
      const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (t < FIRST_SLOT || t > LAST_SLOT)
        return { ok: false, error: "is outside our calling hours (8 AM to 9 PM, last slot 8:30 PM)" };
      return { ok: true, value: t };
    }
  }
}

/* ---------------- merge ---------------- */

export function mergeExtracted(prev: BotState, exIn: Extracted) {
  const ex: Extracted = { ...exIn };
  const s: BotState = {
    ...prev,
    details: { ...prev.details },
    pending: [...(prev.pending ?? [])],
    lastAttempt: { ...(prev.lastAttempt ?? {}) },
    attempts: { ...prev.attempts },
  };
  const errors: string[] = [];
  const notes: string[] = [];

  // 0) The model often repeats values it just heard in the read-back. A value
  //    identical to one already pending or confirmed is not a new answer.
  for (const f of ["phone", "email"] as const) {
    const raw = ex[f];
    if (!raw) continue;
    const r = validateField(f, raw);
    if (r.ok && (r.value === s[f] || s.pending.some((p) => p.field === f && p.value === r.value))) {
      delete ex[f];
    }
  }

  // 1) Resolve an open read-back first.
  if (s.pending.length && ex.confirmation) {
    if (ex.confirmation === "yes") {
      for (const p of s.pending) s[p.field] = p.value;
      notes.push(`Customer confirmed: ${s.pending.map((p) => p.field).join(" and ")}.`);
      s.pending = [];
    } else {
      for (const p of s.pending) s.lastAttempt[p.field] = p.value;
      errors.push(
        `Customer said the read-back of ${s.pending.map((p) => p.field).join(" and ")} was wrong. Ask them to say it again slowly.`,
      );
      s.pending = [];
    }
  }

  // 2) Validate any new values.
  const fields: Field[] = ["name", "phone", "email", "date", "time"];
  for (const f of fields) {
    const raw = ex[f];
    if (!raw) continue;
    const r = validateField(f, raw);
    if (!r.ok) {
      s.attempts[f] = (s.attempts[f] ?? 0) + 1;
      s.lastAttempt[f] = String(raw);
      errors.push(`${f} "${raw}" ${r.error} (failed attempt ${s.attempts[f]})`);
      continue;
    }
    delete s.lastAttempt[f];
    if (f === "phone" || f === "email") {
      // Never save contact details without a read-back.
      s.pending = s.pending.filter((p) => p.field !== f);
      s.pending.push({ field: f, value: r.value });
      s[f] = undefined;
    } else {
      s[f] = r.value;
    }
  }

  // A slot later today must still be in the future.
  if (s.date && s.time && s.date === todayIST() && s.time <= nowHHMM()) {
    errors.push(`time ${s.time} today has already passed`);
    s.lastAttempt.time = s.time;
    s.time = undefined;
  }

  if (ex.purpose && ex.purpose !== s.purpose) {
    s.purpose = ex.purpose;
    s.details = {};
    s.detailsComplete = false;
  }
  if (ex.details) {
    for (const [k, v] of Object.entries(ex.details)) {
      if (v && String(v).trim()) s.details[k] = String(v).trim();
    }
  }
  if (ex.details_complete) s.detailsComplete = true;
  if (s.purpose === "talk_to_agent") s.detailsComplete = true;

  return { state: s, errors, notes };
}

/* ---------------- what to ask next ---------------- */

export type Step =
  | "name"
  | "confirm"
  | "phone"
  | "email"
  | "purpose"
  | "details"
  | "date"
  | "time";

export function nextSteps(s: BotState): Step[] {
  const m: Step[] = [];
  if (!s.name) m.push("name");
  if (s.pending.length) m.push("confirm");
  if (!s.phone && !s.pending.some((p) => p.field === "phone")) m.push("phone");
  if (!s.email && !s.pending.some((p) => p.field === "email")) m.push("email");
  if (!s.purpose) m.push("purpose");
  else if (!s.detailsComplete) m.push("details");
  if (!s.date) m.push("date");
  if (!s.time) m.push("time");
  return m;
}

export function describeStep(step: Step, s: BotState): string {
  switch (step) {
    case "confirm":
      return `READ BACK and confirm: ${s.pending
        .map((p) => `${p.field} = ${p.field === "phone" ? phoneReadback(p.value) : emailReadback(p.value)}`)
        .join("; ")}`;
    case "details":
      return `follow-up questions for ${PURPOSE_LABEL[s.purpose!]}`;
    default:
      return step;
  }
}

/** Deterministic fallback question, used if the model's reply is empty or has no question. */
export function fallbackQuestion(step: Step, s: BotState): string {
  switch (step) {
    case "name":
      return "May I have your full name, please?";
    case "confirm": {
      const parts = s.pending.map((p) =>
        p.field === "phone"
          ? `your mobile number is ${phoneReadback(p.value)}`
          : `your email is ${emailReadback(p.value)}`,
      );
      return `Just to confirm, ${parts.join(", and ")}. Is that correct?`;
    }
    case "phone":
      return "Could you share your 10-digit mobile number?";
    case "email":
      return "And what's your email address?";
    case "purpose":
      return "How can I help you today? Is it about an EMI, a payment arrangement, a new loan, or would you like to speak to an agent?";
    case "details":
      return "Could you tell me a little more about that?";
    case "date":
      return "What date would you like our specialist to call you back?";
    case "time":
      return "And what time suits you? We call between 8 AM and 9 PM.";
  }
}

/* ---------------- display ---------------- */

export function prettyDate(ymd?: string): string {
  if (!ymd) return "";
  return new Date(ymd + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function prettyTime(hhmm?: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}
