# Quick Start: Deploy Local Code to Railway

Since your code is local, here's the fastest way:

## Option 1: Push to GitHub First (Recommended - 5 minutes)

1. **Create a GitHub repo** (if you don't have one):
   - Go to https://github.com/new
   - Create a new repository
   - Don't initialize with README

2. **Push your code to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/yourusername/your-repo-name.git
   git push -u origin main
   ```

3. **In Railway**, click **"Connect Repo"** button
   - Select your GitHub repo
   - Railway will auto-detect Node.js and deploy!

## Option 2: Use Railway CLI (Alternative)

1. **Install Railway CLI:**
   ```bash
   npm i -g @railway/cli
   ```

2. **Login:**
   ```bash
   railway login
   ```

3. **Deploy from your local folder:**
   ```bash
   railway init
   railway up
   ```

## After Deployment

1. **Set Environment Variable:**
   - In Railway → Your service → **Variables** tab
   - Add: `OPENAI_API_KEY` = `your-key-here`

2. **Update CORS in server.js:**
   - Add your Framer domain to the `allowedOrigins` array (line 9)

3. **Get your URL:**
   - Railway gives you: `https://your-app.up.railway.app`
   - Use this in your Framer component!

