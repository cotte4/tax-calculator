# Railway Setup Guide

Perfect! Since you already have Railway, this is actually the easiest option.

## Quick Setup on Railway

### Step 1: Prepare Your Files

You need these files in your Railway project:
- `server.js` - Your Express server
- `package.json` - Dependencies
- `.gitignore` - To protect your `.env` file

### Step 2: Deploy to Railway

1. **In Railway Dashboard**, click **"Empty Service"** (or "New" → "Empty Service")
2. **Two options to add your code:**

   **Option A: Upload from GitHub (Recommended)**
   - If your code is in GitHub, click **"GitHub Repository"** instead
   - Connect your repo
   - Railway will auto-detect it's Node.js

   **Option B: Upload files directly**
   - In the empty service, go to **Settings** → **Source**
   - Upload or drag & drop:
     - `server.js`
     - `package.json`
     - `.gitignore`

### Step 3: Set Environment Variable

1. In Railway project → **Variables** tab
2. Click **+ New Variable**
3. Add:
   - **Name**: `OPENAI_API_KEY`
   - **Value**: `sk-proj-your-key-here` (your OpenAI API key)
4. Click **Add**

### Step 4: Configure Your Service

1. Railway will auto-detect it's a Node.js app
2. Make sure the **Start Command** is: `node server.js`
3. Railway will automatically assign a domain like: `your-app.up.railway.app`

### Step 5: Update CORS in server.js

1. Open `server.js`
2. Find the `allowedOrigins` array (around line 9)
3. Add your Framer site URL:
   ```javascript
   const allowedOrigins = [
     'https://your-framer-site.framer.website',
     'http://localhost:3000',
   ];
   ```

### Step 6: Use in Framer

In your Framer component, use your Railway URL:

```tsx
<CalculatorEmbed 
  apiBaseUrl="https://your-app.up.railway.app"
  onSuccess={(result) => console.log(result)}
/>
```

## That's It!

Railway will:
- ✅ Automatically deploy when you push changes
- ✅ Handle HTTPS/SSL certificates
- ✅ Keep your server running 24/7
- ✅ Provide logs and monitoring

## Testing

Test your endpoint:
```bash
curl -X POST https://your-app.up.railway.app/api/calculate \
  -H "Content-Type: application/json" \
  -d '{"box2Federal": 1000, "box17State": 500}'
```

You should get a JSON response with the estimated refund.

## Troubleshooting

- **Port issues**: Railway automatically sets `PORT` environment variable, so `server.js` will use it
- **CORS errors**: Make sure your Framer domain is in the `allowedOrigins` array
- **API key errors**: Check that `OPENAI_API_KEY` is set correctly in Railway Variables

