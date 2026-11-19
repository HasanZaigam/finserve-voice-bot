// Google Calendar via a service account (server-side only).
import { JWT } from "google-auth-library";
import { FIRST_SLOT, LAST_SLOT, nowHHMM, prettyTime, todayIST } from "./state";

const CAL_ID = process.env.GOOGLE_CALENDAR_ID;
const SLOT_MIN = 30;

export function calendarConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_PRIVATE_KEY &&
      CAL_ID,
  );
}

let jwt: JWT | null = null;
function auth(): JWT {
  if (!jwt) {
    jwt = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // Vercel / .env often store the key with literal "\n"
      key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
  }
  return jwt;
}

async function gcal<T>(path: string, body: unknown): Promise<T> {
  const { token } = await auth().getAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const iso = (date: string, time: string) => `${date}T${time}:00+05:30`;
const ms = (date: string, time: string) => new Date(iso(date, time)).getTime();

function plusMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** All 30-minute slots in calling hours, minus ones already passed today. */
export function allSlots(date: string): string[] {
  const out: string[] = [];
  for (let t = FIRST_SLOT; t <= LAST_SLOT; t = plusMinutes(t, SLOT_MIN)) out.push(t);
  return date === todayIST() ? out.filter((t) => t > nowHHMM()) : out;
}

async function busyRanges(date: string): Promise<[number, number][]> {
  const data = await gcal<{
    calendars: Record<string, { busy?: { start: string; end: string }[] }>;
  }>("/freeBusy", {
    timeMin: iso(date, "00:00"),
    timeMax: iso(date, "23:59"),
    timeZone: "Asia/Kolkata",
    items: [{ id: CAL_ID }],
  });
  return (data.calendars[CAL_ID!]?.busy ?? []).map((b) => [
    new Date(b.start).getTime(),
    new Date(b.end).getTime(),
  ]);
}

function overlaps(date: string, time: string, busy: [number, number][]) {
  const start = ms(date, time);
  const end = start + SLOT_MIN * 60_000;
  return busy.some(([b0, b1]) => start < b1 && end > b0);
}

export async function freeSlots(date: string): Promise<string[]> {
  const slots = allSlots(date);
  if (!calendarConfigured()) return slots;
  try {
    const busy = await busyRanges(date);
    return slots.filter((t) => !overlaps(date, t, busy));
  } catch (e) {
    console.error("freeBusy failed", e);
    return slots;
  }
}

export async function isSlotFree(date: string, time: string): Promise<boolean> {
  if (!calendarConfigured()) return true;
  try {
    return !overlaps(date, time, await busyRanges(date));
  } catch (e) {
    console.error("freeBusy failed", e);
    return true;
  }
}

/** Slots closest to the requested time, for suggestions. */
export function nearest(slots: string[], time: string, n = 3): string[] {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return [...slots]
    .sort((a, b) => Math.abs(toMin(a) - toMin(time)) - Math.abs(toMin(b) - toMin(time)))
    .slice(0, n)
    .sort();
}

export function speakSlots(slots: string[]): string {
  return slots.map(prettyTime).join(", ");
}

export interface CallbackInput {
  name: string;
  phone: string;
  email: string;
  purposeLabel: string;
  details: string;
  summary: string;
  date: string;
  time: string;
}

export async function createCallbackEvent(
  b: CallbackInput,
): Promise<{ eventId: string; eventLink: string }> {
  const ev = await gcal<{ id: string; htmlLink: string }>(
    `/calendars/${encodeURIComponent(CAL_ID!)}/events`,
    {
      summary: `Callback: ${b.name} (${b.purposeLabel})`,
      description: [
        `Customer: ${b.name}`,
        `Mobile: +91 ${b.phone}`,
        `Email: ${b.email}`,
        `Purpose: ${b.purposeLabel}`,
        b.details ? `Details: ${b.details}` : "",
        "",
        `Handover note: ${b.summary}`,
        "",
        "Booked by FinServe AI assistant.",
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
      start: { dateTime: iso(b.date, b.time), timeZone: "Asia/Kolkata" },
      end: { dateTime: iso(b.date, plusMinutes(b.time, SLOT_MIN)), timeZone: "Asia/Kolkata" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    },
  );
  return { eventId: ev.id, eventLink: ev.htmlLink };
}
