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
- A Block API key and basic familiarity with your Block docs at [https://useblock.tech/docs](https://useblock.tech/docs)
- A Block connection ID (created via the Block developer portal)

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
DEFAULT_PROVIDER="Get this from the connected booking system"
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

## Possible Extensions

- Add more tools (e.g., `get_availability`)
- Implement webhook handling instead of polling
- Style the chat widget to match your brand
- Deploy to a hosting service (Vercel, Railway, etc.)
- Set up chat history persistence

---

## License

MIT

**Note:** This tutorial application uses the Block API, which is subject to the Block Integration API Terms of Service. By using this code with the Block API, you agree to comply with those terms.
