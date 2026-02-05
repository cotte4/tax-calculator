const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - update with your Framer domain
const allowedOrigins = [
  'https://www.jai1taxes.com',
  'https://jai1taxes.com',
  'http://localhost:3000',
  'http://localhost:5173', // Vite dev server
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Calculate endpoint
app.post('/api/calculate', async (req, res) => {
  try {
    const { box2Federal, box17State } = req.body;

    // Validate inputs
    if (
      typeof box2Federal !== 'number' ||
      typeof box17State !== 'number' ||
      !Number.isFinite(box2Federal) ||
      !Number.isFinite(box17State) ||
      box2Federal < 0 ||
      box17State < 0
    ) {
      return res.status(400).json({ error: 'Invalid input values' });
    }

    // Get OpenAI API key from environment
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      console.error('OPENAI_API_KEY is not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Call OpenAI API with the cheapest model
    const openaiResponse = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Cheapest model
          messages: [
            {
              role: 'system',
              content:
                'You are a tax refund calculator. Calculate the estimated refund based on federal and state tax amounts. Return only a JSON object with the estimated refund amount as a number. The refund is typically calculated as the difference between taxes withheld and taxes owed, but use standard tax calculation logic.',
            },
            {
              role: 'user',
              content: `Calculate the estimated tax refund. Federal tax amount (Box 2): $${box2Federal}. State tax amount (Box 17): $${box17State}. Return a JSON object with: { "estimatedRefund": <number> }`,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 150,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.text();
      console.error('OpenAI API error:', errorData);
      return res.status(500).json({ error: 'Failed to calculate estimate' });
    }

    const openaiData = await openaiResponse.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(500).json({ error: 'Invalid response from AI' });
    }

    // Parse the JSON response from OpenAI
    let aiResult;
    try {
      aiResult = JSON.parse(content);
    } catch {
      // Fallback: simple calculation if JSON parsing fails
      const estimatedRefund =
        box2Federal + box17State - (box2Federal * 0.1 + box17State * 0.05);
      aiResult = { estimatedRefund: Math.max(0, estimatedRefund) };
    }

    const estimatedRefund =
      typeof aiResult.estimatedRefund === 'number'
        ? aiResult.estimatedRefund
        : Math.max(
            0,
            box2Federal + box17State - (box2Federal * 0.1 + box17State * 0.05)
          );

    // Return response in the expected format
    const response = {
      box2Federal,
      box17State,
      estimatedRefund: Math.round(estimatedRefund * 100) / 100, // Round to 2 decimal places
      ocrConfidence: 'manual',
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('Error in calculate endpoint:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: http://localhost:${PORT}/api/calculate`);
});

