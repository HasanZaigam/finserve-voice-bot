import { NextResponse } from "next/server";
import {
  emailReadback,
  phoneReadback,
  prettyDate,
  prettyTime,
  PURPOSE_LABEL,
  Purpose,
  validateField,
  todayIST,
  nowHHMM,
} from "../../../../lib/state";
import {
  calendarConfigured,
  createCallbackEvent,
  freeSlots,
  isSlotFree,
  nearest,
  speakSlots,
} from "../../../../lib/calendar";

export const maxDuration = 30;

type Args = Record<string, string | undefined>;

/* Every result carries kind: "finserve_*" so the browser can pick it out of
   Vapi's client messages and update the live lead card. */

function checkDetails(a: Args) {
  const fields: Record<string, unknown> = {};
  const say: string[] = [];
  if (a.name) {
    const r = validateField("name", a.name);
    fields.name = r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
    if (!r.ok) say.push(`The name ${r.error}; ask again.`);
  }
  if (a.phone) {
    const r = validateField("phone", a.phone);
    if (r.ok) {
      fields.phone = { ok: true, value: r.value, readback: phoneReadback(r.value) };
      say.push(`Read back the mobile number as "${phoneReadback(r.value)}" and ask if it's correct.`);
    } else {
      fields.phone = { ok: false, heard: a.phone, error: r.error };
      say.push(`The mobile number ${r.error}. Tell the caller and ask again.`);
    }
  }
  if (a.email) {
    const r = validateField("email", a.email);
    if (r.ok) {
      fields.email = { ok: true, value: r.value, readback: emailReadback(r.value) };
      say.push(`Spell the email back as "${emailReadback(r.value)}" and ask if it's correct.`);
    } else {
      fields.email = { ok: false, heard: a.email, error: r.error };
      say.push(`The email ${r.error}. Ask the caller.`);
    }
  }
  if (a.purpose && a.purpose in PURPOSE_LABEL) {
    fields.purpose = { ok: true, value: a.purpose, label: PURPOSE_LABEL[a.purpose as Purpose] };
    say.push("Purpose recorded. Continue with the follow-up questions.");
  }
  return { kind: "finserve_details", fields, instruction: say.join(" ") || "Nothing to check." };
}

async function checkAvailability(a: Args) {
  const d = validateField("date", a.date ?? "");
  if (!d.ok) {
    return { kind: "finserve_availability", ok: false, instruction: `The date ${d.error}. Ask for another date.` };
  }
  const date = d.value;
  const slots = await freeSlots(date);
  if (!slots.length) {
    return {
      kind: "finserve_availability",
      ok: false,
      date,
      instruction: `No free slots on ${prettyDate(date)}. Ask for another day.`,
    };
  }
  if (!a.time) {
    const first = slots[0];
    const last = slots[slots.length - 1];
    return {
      kind: "finserve_availability",
      ok: true,
      date,
      instruction: `${prettyDate(date)} is available between ${prettyTime(first)} and ${prettyTime(last)}. Ask what time suits them.`,
    };
  }
  const t = validateField("time", a.time);
  if (!t.ok) {
    return {
      kind: "finserve_availability",
      ok: false,
      date,
      instruction: `That time ${t.error}. Offer: ${speakSlots(nearest(slots, "17:00"))}.`,
    };
  }
  if (date === todayIST() && t.value <= nowHHMM()) {
    return {
      kind: "finserve_availability",
      ok: false,
      date,
      instruction: `That time has already passed today. Offer: ${speakSlots(nearest(slots, t.value))}.`,
    };
  }
  if (!(await isSlotFree(date, t.value))) {
    return {
      kind: "finserve_availability",
      ok: false,
      date,
      instruction: `${prettyTime(t.value)} is already taken. Offer: ${speakSlots(nearest(slots, t.value))}.`,
    };
  }
  return {
    kind: "finserve_availability",
    ok: true,
    date,
    time: t.value,
    instruction: `${prettyTime(t.value)} on ${prettyDate(date)} is free. Recap and ask if you should book it.`,
  };
}

async function bookCallback(a: Args) {
  const problems: string[] = [];
  const v: Record<string, string> = {};
  for (const f of ["name", "phone", "email", "date", "time"] as const) {
    const r = validateField(f, a[f] ?? "");
    if (r.ok) v[f] = r.value;
    else problems.push(`${f} ${r.error}`);
  }
  const purpose = (a.purpose && a.purpose in PURPOSE_LABEL ? a.purpose : "other") as Purpose;
  if (problems.length) {
    return { kind: "finserve_booking", booked: false, instruction: `Cannot book yet: ${problems.join("; ")}. Fix with the caller.` };
  }
  if (!(await isSlotFree(v.date, v.time))) {
    const alt = nearest(await freeSlots(v.date), v.time);
    return {
      kind: "finserve_booking",
      booked: false,
      instruction: `That slot was just taken. Offer: ${speakSlots(alt)}.`,
    };
  }

  const booking = {
    name: v.name,
    phone: v.phone,
    email: v.email,
    purpose,
    purposeLabel: PURPOSE_LABEL[purpose],
    details: a.details ?? "",
    summary: a.handover_note ?? "",
    date: v.date,
    time: v.time,
  };

  let calendar: { status: string; eventId?: string; eventLink?: string } = {
    status: "calendar_unavailable",
  };
  if (calendarConfigured()) {
    try {
      const ev = await createCallbackEvent(booking);
      calendar = { status: "booked", ...ev };
    } catch (e) {
      console.error("Calendar booking failed", e);
      calendar = { status: "calendar_error" };
    }
  }

  return {
    kind: "finserve_booking",
    booked: true,
    booking: { ...booking, ...calendar },
    instruction: `Booked for ${prettyDate(v.date)} at ${prettyTime(v.time)}. Tell the caller a specialist will call them then, and ask if there's anything else.`,
  };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const message = body?.message;
  if (message?.type !== "tool-calls") return NextResponse.json({ ok: true });

  const calls: any[] = message.toolCallList ?? [];
  const results = await Promise.all(
    calls.map(async (c) => {
      const name: string = c.function?.name ?? c.name;
      let args: any = c.function?.arguments ?? c.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      let out: unknown;
      try {
        if (name === "check_details") out = checkDetails(args);
        else if (name === "check_availability") out = await checkAvailability(args);
        else if (name === "book_callback") out = await bookCallback(args);
        else out = { error: `Unknown tool ${name}` };
      } catch (e) {
        console.error(e);
        out = { error: "Something went wrong. Apologise and try once more." };
      }
      return { toolCallId: c.id, result: JSON.stringify(out) };
    }),
  );
  return NextResponse.json({ results });
}
