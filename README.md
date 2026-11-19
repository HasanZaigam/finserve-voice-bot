# FinServe AI Voice Assistant: Inbound Enquiry & Callback Scheduling Bot

A conversational bot (text **and** browser voice) that answers an inbound customer line for a fictional lender, **FinServe Finance**. It greets the caller, collects their details, asks follow-up questions based on why they are calling, books a callback with a human loan specialist, and shows a confirmation with an AI-written handover note.

The use case is modelled on AI-answered inbound calls in loan servicing / collections: a borrower calls back about an EMI, a payment difficulty, or a new loan, and the AI qualifies the call and hands it to a human (human-in-the-loop).

**Live demo:** <add Vercel link>  ·  **Screen recording:** <add Loom link>

---

## Features (mapped to the brief)

| Requirement | How it's handled |
|---|---|
| Welcome message | Greeting with a call-recording disclosure, as in a real contact centre |
| Data collection | Name, mobile, email, purpose of enquiry, each validated before it is saved |
| Conversational flow | Purpose-specific follow-ups: **EMI query**, **payment arrangement**, **new loan**, **talk to an agent**, **other** |
| Appointment scheduling | Preferred callback date and time, understood from natural language ("tomorrow at 5", "next Monday morning at 10:30") |
| Confirmation | Confirmation card with all details plus an AI-generated handover note for the agent |
| Error handling | Invalid phone or email, past dates, out-of-hours times, vague answers ("evening"), unclear or off-topic messages, no speech heard, mic blocked, API failure |
| **Bonus:** AI API | Anthropic Claude (Haiku) for extraction, natural replies and summaries |
| **Bonus:** voice | "Start voice call" mode: browser speech-to-text and text-to-speech, auto-listens after each reply like a phone call |
| **Bonus:** scheduling tool | "Add to calendar" exports a standard `.ics` event (works with Google Calendar, Outlook, Apple Calendar) |

## Architecture

```
Browser (chat + Web Speech API)
   │  messages + current state
   ▼
Next.js API route  /api/chat
   ├─ 1. Extract   → Claude, forced tool call `update_customer_info` → structured fields
   ├─ 2. Validate  → TypeScript rules (lib/state.ts) → merge into state, record errors
   ├─ 3. Reply     → Claude writes the next turn from state, errors and missing fields
   └─ 4. Summarise → when all fields are complete, Claude writes the agent handover note
   ▼
Reply is shown, and spoken aloud in voice mode
```

**Key design decision: the LLM talks, code decides.** Claude handles the language: it understands messy input and phrases questions naturally. Code handles correctness: it validates every field, tracks what's still missing, and decides when the conversation is complete. The bot can't skip a field, hallucinate a booking, or accept an invalid number.

### Validation rules
- Mobile: 10-digit Indian number starting 6 to 9 (`+91` and a leading `0` are stripped)
- Email: standard format, lower-cased
- Date: not in the past, within the next 30 days
- Time: inside calling hours, 8:00 AM to 8:30 PM IST (last slot), and not already passed if the date is today
- After 2 failed attempts the bot gives an example of the expected format

### Compliance touches
- Call-recording disclosure in the greeting
- Never asks for full account numbers, card numbers, OTP or PIN, and warns the caller if they offer them
- No promises of waivers, rates or approvals; resolutions are left to the human specialist
- Callbacks only offered inside permitted calling hours

## Tech stack
- **Next.js 15 (App Router) + TypeScript**, deployed on **Vercel**
- **Anthropic Claude API** (`claude-haiku-5-5`, chosen for low latency on voice) with tool calling
- **Web Speech API**: `SpeechRecognition` (en-IN) and `speechSynthesis`
- **iCalendar (.ics)** export for scheduling
- Built with an AI coding assistant (Claude), vibe-coded end to end

## Run locally
```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```
Voice mode needs Chrome or Edge, and microphone permission.

## Project structure
```
app/page.tsx            Chat + voice UI, live "captured so far" panel, confirmation card
app/api/chat/route.ts   Extract → validate → reply → summary pipeline
lib/state.ts            State shape, validators, missing-field logic
lib/prompt.ts           Greeting, system prompts, purpose-specific follow-up flows
lib/ics.ts              Calendar file generation
```

## Next steps (with more time)
- Real phone line via Vapi / Retell or Twilio for a true inbound call-centre experience
- Google Calendar API with live slot availability and agent assignment
- Persist leads to a database or CRM, and send SMS/email confirmations
- Hindi / Hinglish support
- Streaming responses to cut voice latency further
