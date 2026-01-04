# Readify API

Backend API for the Readify Chrome Extension. Provides REST endpoints for Stripe payments and site management, plus WebSocket support for real-time features.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: Supabase (PostgreSQL)
- **Payments**: Stripe
- **Real-time**: WebSocket (ws)
- **Deployment**: Render

## Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm
- Supabase project
- Stripe account

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd readify-api

# Install dependencies
npm install

# Copy environment variables
cp env.example .env

# Edit .env with your values
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | Environment (development/production) |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Default Stripe price ID |
| `OPENAI_API_KEY` | OpenAI API key (for future use) |
| `FRONTEND_URL` | Allowed frontend origin for CORS |

### Development

```bash
# Start development server with hot reload
npm run dev
```

### Production Build

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

## API Endpoints

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Basic health check |
| GET | `/health/ready` | Detailed readiness check |

### Stripe

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/stripe/create-checkout-session` | Create Stripe checkout session |
| POST | `/api/stripe/create-portal-session` | Create Stripe customer portal session |
| POST | `/api/stripe/cancel-subscription` | Cancel subscription at period end |
| POST | `/api/stripe/webhook` | Stripe webhook handler |

### Sites

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sites/save` | Save site data |
| GET | `/api/sites/list` | List all user sites |
| GET | `/api/sites/:urlDigest` | Get specific site |
| DELETE | `/api/sites/:urlDigest` | Delete a site |

## WebSocket

Connect to `ws://localhost:3000/ws` with authentication token:

```javascript
// Connect with token in query string
const ws = new WebSocket('ws://localhost:3000/ws?token=YOUR_JWT_TOKEN');

// Or in header (if supported by client)
const ws = new WebSocket('ws://localhost:3000/ws', {
  headers: { Authorization: 'Bearer YOUR_JWT_TOKEN' }
});
```

### Message Types

```javascript
// Ping/pong
ws.send(JSON.stringify({ type: 'ping' }));

// Chat (future OpenAI integration)
ws.send(JSON.stringify({ 
  type: 'chat', 
  payload: { message: 'Hello' } 
}));
```

## Deployment to Render

### Option 1: Blueprint (Recommended)

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click "New" → "Blueprint"
4. Connect your repo
5. Render will use `render.yaml` to configure the service
6. Add environment variables in Render dashboard

### Option 2: Manual Setup

1. Create a new Web Service on Render
2. Connect your GitHub repo
3. Configure:
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
4. Add environment variables
5. Deploy

### Stripe Webhook Configuration

After deployment, update your Stripe webhook endpoint:

1. Go to Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://your-render-url.onrender.com/api/stripe/webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`

## Project Structure

```
src/
├── config/
│   └── env.ts          # Environment configuration
├── lib/
│   ├── supabase.ts     # Supabase client
│   └── stripe.ts       # Stripe client
├── middleware/
│   ├── auth.ts         # JWT authentication
│   └── error.ts        # Error handling
├── routes/
│   ├── health.ts       # Health checks
│   ├── stripe.ts       # Stripe endpoints
│   └── sites.ts        # Site management
├── websocket/
│   └── handler.ts      # WebSocket handling
├── server.ts           # Express app setup
└── index.ts            # Entry point
```

## Future: OpenAI Integration

The WebSocket infrastructure is ready for OpenAI Realtime API integration. The `handleChatMessage` function in `src/websocket/handler.ts` is the placeholder for this functionality.

## License

ISC

