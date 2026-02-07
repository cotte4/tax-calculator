const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration – calculator lives at https://www.jai1taxes.com/calculadora
const allowedOrigins = [
  "https://www.jai1taxes.com", // production calculadora
  "https://jai1taxes.com",
  "http://localhost:3000",
  "http://localhost:5173", // Vite dev server
];

// Optional: extra origins from env (e.g. in Railway: ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com)
if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(",").forEach((o) => {
    const trimmed = o.trim();
    if (trimmed) allowedOrigins.push(trimmed);
  });
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ✅ REQUIRED for Railway + browser preflight
app.options("*", cors());


app.use(express.json());

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept images only
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Tax Calculator API is running",
    endpoints: {
      uploadW2: {
        path: "/api/upload-w2",
        method: "POST",
        description: "Upload W-2 image to extract Box 2 and Box 17 values using OpenAI Vision",
        contentType: "multipart/form-data",
        field: "w2Image",
      },
      calculate: {
        path: "/api/calculate",
        method: "POST",
        description: "Calculate refund from manually entered Box 2 and Box 17 values",
        body: { box2Federal: "number", box17State: "number" },
      },
    },
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Helper function to calculate refund
function calculateRefund(box2Federal, box17State) {
  const totalWithheld = box2Federal + box17State;
  // Estimate federal liability (~12% of withheld for J1 holders after deductions)
  const estimatedFederalLiability = box2Federal * 0.12;
  // Estimate state liability (~4% of withheld for J1 holders)
  const estimatedStateLiability = box17State * 0.04;
  // Calculate refund: withheld minus estimated liability
  return Math.max(0, totalWithheld - estimatedFederalLiability - estimatedStateLiability);
}

// W-2 upload and extraction endpoint
app.post("/api/upload-w2", upload.single("w2Image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(500).json({ error: "Server configuration error: OPENAI_API_KEY not set" });
    }

    // Convert image buffer to base64
    const base64Image = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;

    // Call OpenAI Vision API to extract W-2 values
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini", // Vision-capable model
          messages: [
            {
              role: "system",
              content:
                "You are a W-2 form extractor. Extract the values from Box 2 (Federal income tax withheld) and Box 17 (State income tax withheld) from this W-2 form image. Return ONLY a JSON object with these exact fields: { \"box2Federal\": <number>, \"box17State\": <number> }. If a value is not found or cannot be read, use 0 for that field. Extract only numeric values, removing any dollar signs or commas.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract Box 2 (Federal income tax withheld) and Box 17 (State income tax withheld) from this W-2 form. Return JSON with box2Federal and box17State as numbers.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                  },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 200,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const errorData = await openaiResponse.text();
      console.error("OpenAI API error:", errorData);
      return res.status(500).json({ error: "Failed to extract W-2 data" });
    }

    const openaiData = await openaiResponse.json();
    const content = openaiData.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(500).json({ error: "Invalid response from AI" });
    }

    // Parse extracted values
    let extractedData;
    try {
      extractedData = JSON.parse(content);
    } catch (parseError) {
      console.error("Failed to parse OpenAI response:", parseError);
      return res.status(500).json({ error: "Failed to parse extracted data" });
    }

    const box2Federal = typeof extractedData.box2Federal === "number" 
      ? extractedData.box2Federal 
      : parseFloat(extractedData.box2Federal) || 0;
    const box17State = typeof extractedData.box17State === "number"
      ? extractedData.box17State
      : parseFloat(extractedData.box17State) || 0;

    // Validate extracted values
    if (
      !Number.isFinite(box2Federal) ||
      !Number.isFinite(box17State) ||
      box2Federal < 0 ||
      box17State < 0
    ) {
      return res.status(400).json({ 
        error: "Invalid values extracted from W-2",
        extracted: extractedData 
      });
    }

    // Calculate refund
    const estimatedRefund = calculateRefund(box2Federal, box17State);

    // Return response
    return res.status(200).json({
      box2Federal,
      box17State,
      estimatedRefund: Math.round(estimatedRefund * 100) / 100,
      ocrConfidence: "ai-extracted",
    });
  } catch (error) {
    console.error("Error in upload-w2 endpoint:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Calculate endpoint (for manual entry - no AI needed, just math)
app.post("/api/calculate", (req, res) => {
  try {
    const { box2Federal, box17State } = req.body;

    // Validate inputs
    if (
      typeof box2Federal !== "number" ||
      typeof box17State !== "number" ||
      !Number.isFinite(box2Federal) ||
      !Number.isFinite(box17State) ||
      box2Federal < 0 ||
      box17State < 0
    ) {
      return res.status(400).json({ error: "Invalid input values" });
    }

    // Calculate refund using proper formula
    const estimatedRefund = calculateRefund(box2Federal, box17State);

    // Return response in the expected format
    return res.status(200).json({
      box2Federal,
      box17State,
      estimatedRefund: Math.round(estimatedRefund * 100) / 100, // Round to 2 decimal places
      ocrConfidence: "manual",
    });
  } catch (error) {
    console.error("Error in calculate endpoint:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API endpoint: http://localhost:${PORT}/api/calculate`);
});
