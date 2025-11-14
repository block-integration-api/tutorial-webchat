# Tutorial: Build a Minimal Web Chat that Books Appointments via Block

In this tutorial you'll build a tiny web chat widget where:

- The frontend is a simple HTML/JS chat UI.
- The backend uses:
  - An LLM (example: OpenAI) with tool calling.
  - The Block API as the implementation of the `book_appointment` tool.

The goal is to show that:

**"From a webchat, it only takes a small tool + one HTTP call to use Block to book across any platform."**

---

## 1. Prerequisites

You'll need:

- Node.js 18+
- An OpenAI API key (or another LLM that supports tools / function calling)
- A Block API key and basic familiarity with your Block docs at [https://useblock.tech/docs](https://useblock.tech/docs) (for:
  - Base URL
  - "Create appointment" endpoint
  - Required fields)
- A Block connection ID (created via the Block developer portal)

For the rest of this tutorial I'll assume:

`BLOCK_API_BASE_URL = https://api.useblock.tech`

🔧 Replace the URL and payload shape with whatever your real "create appointment" endpoint is.

---

## 2. Project Structure

We'll keep everything in a single Node project for minimal setup:

```
block-webchat-tutorial/
  package.json
  server.js
  .env.example
  public/
    index.html
    styles.css
    app.js
```

---

## 3. Initialize the project

```bash
mkdir block-webchat-tutorial
cd block-webchat-tutorial
npm init -y
npm install express cors dotenv openai
```

Create a `.env.example`:

```bash
cat > .env.example << 'EOF'
OPENAI_API_KEY=sk-...
BLOCK_API_KEY=block_key_...
BLOCK_API_BASE_URL=https://api.useblock.tech
CONNECTION_ID=conn_...
PORT=3000
EOF
```

Then create your real `.env` and fill in the values:

```bash
cp .env.example .env
# edit .env with your keys + correct Block base URL
```

---

## 4. Backend: server.js

This file:

1. Serves the static chat UI from `/public`.
2. Exposes `POST /api/chat`.
3. Uses OpenAI with a tool called `book_appointment`.
4. When the LLM calls the tool, the server:
   - Calls the Block API to book
   - Polls for job completion (Block actions are async)
   - Feeds the result back into the LLM
   - Returns the final, user-friendly answer.

See `server.js` for the complete implementation.

### Key Block API Integration Details

The Block API uses an async execution pattern:

1. **POST `/v1/actions`** - Submit the booking action
   - Returns a `jobId` immediately (HTTP 202)
   - Request format:
     ```json
     {
       "action": "BookAppointment",
       "connectionId": "conn_abc123",
       "payload": {
         "datetime": "2025-11-15T14:00:00-08:00",
         "provider": "Carl Morris",
         "service": "60 Minute Massage",
         "customer": {
           "firstName": "Jane",
           "lastName": "Doe",
           "phone": "+12065551212"
         },
         "note": "Optional note"
       }
     }
     ```

2. **GET `/v1/jobs/{jobId}`** - Poll for job status
   - Returns job status: `queued`, `in_progress`, `success`, or `error`
   - When status is `success`, the `result` field contains the booking details

The `bookAppointmentViaBlock` function in `server.js` handles both steps automatically.

🔁 Where to customize for Block:

- The `bookAppointmentViaBlock` function:
  - The URL path: `/v1/actions` (for submitting) and `/v1/jobs/{jobId}` (for polling)
  - The fields you send in `payload`
  - The fields you read from `result`

Check your actual Block docs and adjust: [https://useblock.tech/docs](https://useblock.tech/docs)

---

## 5. Frontend: public/index.html

A super simple chat widget layout:

See `public/index.html` for the complete HTML structure.

---

## 6. Frontend styles: public/styles.css

Minimal styling so it feels like a widget, not a raw page:

See `public/styles.css` for the complete CSS.

---

## 7. Frontend logic: public/app.js

This script:

- Manages the chat history in the browser.
- Sends message + history to `/api/chat`.
- Renders the reply.

See `public/app.js` for the complete implementation.

---

## 8. Running the demo

```bash
npm run dev
# or, if you didn't add a script yet:
# node server.js
```

Then open:

```
http://localhost:3000
```

Try prompts like:

- "I'd like a haircut next Tuesday afternoon."
- "Can you book an AC maintenance visit for tomorrow at 3pm? My name is Alex, phone is 555-123-4567."

You should see:

1. The assistant asking follow-ups until it has name, phone, service, and time.
2. A tool call → your server calls the Block API via `bookAppointmentViaBlock`.
3. A confirmation message summarizing the booked appointment.

---

## 9. How to tailor this to Block (for your final tutorial)

In your published tutorial / README, you can tighten the Block-specific pieces by:

1. Linking directly to the right section of your docs, e.g. "Block → Appointments → Create appointment".
2. Replacing the placeholder `bookAppointmentViaBlock` implementation with the exact code:
   - Correct URL path: `/v1/actions` (for submitting actions)
   - Correct request body fields (action, connectionId, payload)
   - Correct response fields mapped into the object given to the LLM
   - Async job polling pattern (GET `/v1/jobs/{jobId}`)
3. Optionally showing a second tool for "list availability" or "reschedule appointment" to show that once you've wired the first one, the rest is trivial.

---

## Block API Reference

- **Base URL**: `https://api.useblock.tech`
- **Authentication**: `Authorization: Bearer block_key_...`
- **Actions Endpoint**: `POST /v1/actions`
- **Jobs Endpoint**: `GET /v1/jobs/{jobId}`
- **Documentation**: [https://useblock.tech/docs](https://useblock.tech/docs)

### BookAppointment Action

**Request:**
```json
{
  "action": "BookAppointment",
  "connectionId": "conn_abc123",
  "payload": {
    "datetime": "2025-11-15T14:00:00-08:00",
    "provider": "Provider Name",
    "service": "Service Name",
    "customer": {
      "firstName": "Jane",
      "lastName": "Doe",
      "phone": "+12065551212",
      "email": "jane@example.com"
    },
    "note": "Optional note",
    "duration": 60
  }
}
```

**Response (immediate):**
```json
{
  "jobId": "job_789xyz",
  "status": "queued",
  "action": "BookAppointment",
  "connectionId": "conn_abc123",
  "createdAt": "2025-11-12T05:13:45.940072+00:00"
}
```

**Job Status (after polling):**
```json
{
  "jobId": "job_789xyz",
  "status": "success",
  "result": {
    "appointmentId": "appt_123",
    "datetime": "2025-11-15T14:00:00-08:00",
    "service": "Service Name"
  }
}
```

---

## Troubleshooting

### "BLOCK_API_KEY or CONNECTION_ID is not configured"

Make sure your `.env` file contains:
- `BLOCK_API_KEY` - Your Block API key (starts with `block_key_`)
- `CONNECTION_ID` - Your Block connection ID (starts with `conn_`)

### "Booking timed out"

The job polling has a 2-minute timeout. If bookings take longer, you may need to:
- Increase the timeout in `bookAppointmentViaBlock`
- Use webhooks instead of polling (see Block docs)

### "Block API error (401)"

Your API key may be invalid or expired. Check your Block developer portal.

---

## Next Steps

- Add more tools (e.g., `get_availability`, `cancel_appointment`)
- Implement webhook handling instead of polling
- Add error handling and retry logic
- Style the chat widget to match your brand
- Deploy to a hosting service (Vercel, Railway, etc.)

---

## License

MIT

