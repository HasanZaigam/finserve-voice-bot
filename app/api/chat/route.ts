import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { extractSystem, replySystem, SUMMARY_SYSTEM } from "../../../lib/prompt";
import {
  BotState,
  describeStep,
  emptyState,
  Extracted,
  fallbackQuestion,
  mergeExtracted,
  nextSteps,
  nowISTLabel,
  PURPOSE_LABEL,
  PURPOSES,
  prettyTime,
} from "../../../lib/state";
import {
  calendarConfigured,
  createCallbackEvent,
  freeSlots,
  isSlotFree,
  nearest,
  speakSlots,
} from "../../../lib/calendar";

export const maxDuration = 30;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
// Thinking off: on newer models reasoning shares the output budget and can
// leave the visible reply empty or cut off mid-sentence.
const NO_THINKING = { thinking: { type: "disabled" as const } };

type Msg = { role: "user" | "assistant"; content: string };

const extractTool: Anthropic.Tool = {
  name: "update_customer_info",
  description:
    "Record values the customer stated in their latest message. Include only what they actually said.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      phone: { type: "string" },
      email: { type: "string" },
      purpose: { type: "string", enum: PURPOSES },
      details: {
        type: "object",
        description: "Branch-specific answers with snake_case keys",
        additionalProperties: { type: "string" },
      },
      details_complete: { type: "boolean" },
      date: { type: "string", description: "YYYY-MM-DD" },
      time: { type: "string", description: "HH:MM, 24-hour" },
      confirmation: { type: "string", enum: ["yes", "no"] },
    },
  },
};

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages: Msg[] = Array.isArray(body.messages) ? body.messages : [];
    const prevState: BotState = { ...emptyState(), ...(body.state ?? {}) };

    // The API needs the first message to come from the user; the greeting is ours.
    const apiMessages: Msg[] =
      messages[0]?.role === "assistant"
        ? [{ role: "user", content: "(call connected)" }, ...messages]
        : messages;

    const now = nowISTLabel();

    // 1) Extract: Claude turns free text into structured fields.
    const extraction = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      ...NO_THINKING,
      system: extractSystem(now, prevState),
      tools: [extractTool],
      tool_choice: { type: "tool", name: "update_customer_info" },
      messages: apiMessages,
    });
    const toolUse = extraction.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const extracted = (toolUse?.input ?? {}) as Extracted;

    // Don't rely on the model for yes/no after a read-back: detect it in code.
    if (prevState.pending.length && !extracted.confirmation) {
      const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const t = last.toLowerCase().trim();
      const negative = /\b(no|nope|nah|wrong|incorrect|not correct|not right|galat|nahi|nahin)\b/.test(t);
      const positive = /\b(yes|yeah|yep|yup|correct|right|exactly|perfect|sure|ok|okay|confirm(ed)?|haan|han|ha|ji|theek|sahi)\b/.test(t);
      const newContact = prevState.pending.some((p) => extracted[p.field]);
      const movedOn = Boolean(extracted.purpose || extracted.details || extracted.date || extracted.time);
      if (negative && !newContact) extracted.confirmation = "no";
      else if (positive || (movedOn && !newContact)) extracted.confirmation = "yes";
    }

    // 2) Validate in code and merge into state.
    const { state, errors, notes } = mergeExtracted(prevState, extracted);

    // 3) Check the slot against the real calendar.
    if (state.date && state.time && !state.booking) {
      if (!(await isSlotFree(state.date, state.time))) {
        const alt = nearest(await freeSlots(state.date), state.time);
        errors.push(
          `${prettyTime(state.time)} on that date is already booked. ${
            alt.length ? `Offer these free slots: ${speakSlots(alt)}.` : "That day is full; ask for another date."
          }`,
        );
        state.lastAttempt.time = state.time;
        state.time = undefined;
        if (!alt.length) state.date = undefined;
      }
    }

    const steps = nextSteps(state);
    const done = steps.length === 0;

    // 4) When complete: handover note + calendar booking.
    let summary = "";
    if (done && !state.booking) {
      const s = await client.messages.create({
        model: MODEL,
        max_tokens: 400,
        ...NO_THINKING,
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Collected data:\n${JSON.stringify(state, null, 2)}\n\nTranscript:\n${messages
              .map((m) => `${m.role === "user" ? "Customer" : "Bot"}: ${m.content}`)
              .join("\n")}`,
          },
        ],
      });
      summary = textOf(s);

      if (calendarConfigured()) {
        try {
          const ev = await createCallbackEvent({
            name: state.name!,
            phone: state.phone!,
            email: state.email!,
            purposeLabel: PURPOSE_LABEL[state.purpose!],
            details: Object.entries(state.details)
              .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
              .join("; "),
            summary,
            date: state.date!,
            time: state.time!,
          });
          state.booking = { status: "booked", ...ev };
        } catch (e) {
          console.error("Calendar booking failed", e);
          state.booking = { status: "calendar_error" };
        }
      } else {
        state.booking = { status: "calendar_unavailable" };
      }
    }

    // 5) Reply: Claude phrases the next turn naturally.
    const replyRes = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      ...NO_THINKING,
      system: replySystem(
        now,
        state,
        errors,
        notes,
        steps.map((s) => describeStep(s, state)),
        done,
      ),
      messages: apiMessages,
    });
    let reply = textOf(replyRes);
    if (replyRes.stop_reason !== "end_turn") {
      console.warn("Reply stop_reason:", replyRes.stop_reason);
    }

    // Guard rails: never return an empty or dead-end reply.
    if (!done) {
      const q = fallbackQuestion(steps[0], state);
      if (!reply || replyRes.stop_reason === "max_tokens") reply = q;
      else if (!reply.includes("?")) reply = `${reply} ${q}`;

      // The read-back is mandatory: if nothing else needs fixing and the model
      // didn't actually read the pending values back, ask deterministically.
      if (steps[0] === "confirm" && errors.length === 0) {
        const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9@]/g, "");
        const r = norm(reply.replace(/ at /g, "@").replace(/ dot /g, "."));
        const readBack = state.pending.every((p) => r.includes(norm(p.value)));
        if (!readBack || !/correct|right/i.test(reply)) {
          reply = `Got it. ${fallbackQuestion("confirm", state)}`;
        }
      }
    } else if (!reply) {
      reply = "Your callback is booked. You can see the confirmation on screen. Thank you for calling FinServe Finance!";
    }

    return NextResponse.json({ reply, state, done, summary, errors });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Something went wrong talking to the AI service." },
      { status: 500 },
    );
  }
}
