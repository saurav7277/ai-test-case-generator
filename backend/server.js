require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors');
// --- IMPORTANT CHANGE HERE ---
// Import node-fetch. In some versions/setups, the fetch function is the default export.
// We'll use a dynamic import for better compatibility, or explicitly access the default.
// Let's try explicitly accessing the default export if it's there.
const nodeFetch = require('node-fetch');
const fetch = nodeFetch.default || nodeFetch; // Use .default if available, otherwise use it directly


const app = express();
const port = process.env.PORT || 3001; // Backend will run on port 3001

// Middleware
app.use(cors()); // Enable CORS for all origins (for development)
app.use(express.json()); // Parse JSON request bodies

// Get Gemini API Key from environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Proxy for Jira API Calls ---
app.post('/api/jira', async (req, res) => {
    const { jiraUrl, jiraUsername, jiraApiToken, issueId } = req.body;

    if (!jiraUrl || !jiraUsername || !jiraApiToken || !issueId) {
        return res.status(400).json({ error: 'Missing Jira configuration or Issue ID.' });
    }

    try {
        const encodedCredentials = Buffer.from(`${jiraUsername}:${jiraApiToken}`).toString('base64');
        const jiraApiBaseUrl = jiraUrl.endsWith('/') ? jiraUrl : `${jiraUrl}/`;
        const jiraResponse = await fetch(`${jiraApiBaseUrl}rest/api/3/issue/${issueId}`, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Accept': 'application/json'
            }
        });

        if (!jiraResponse.ok) {
            const errorText = await jiraResponse.text();
            return res.status(jiraResponse.status).json({ error: `Jira API Error: ${jiraResponse.status} - ${errorText}` });
        }

        const jiraData = await jiraResponse.json();
        res.json(jiraData);
    } catch (error) {
        console.error('Error proxying Jira request:', error);
        res.status(500).json({ error: 'Failed to fetch Jira issue details via proxy.' });
    }
});

// --- Proxy for Gemini LLM Calls ---
app.post('/api/gemini', async (req, res) => {
    const { prompt, generationConfig, responseSchema } = req.body;

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Gemini API Key not configured on the server.' });
    }
    if (!prompt) {
        return res.status(400).json({ error: 'Missing prompt for Gemini LLM.' });
    }

    try {
        let payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        };

        if (generationConfig) {
            payload.generationConfig = generationConfig;
        }
        if (responseSchema) {
            // responseSchema needs to be inside generationConfig
            payload.generationConfig = {
                ...payload.generationConfig,
                responseMimeType: "application/json",
                responseSchema: responseSchema
            };
        }

        const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

        const geminiResponse = await fetch(geminiApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            return res.status(geminiResponse.status).json({ error: `Gemini API Error: ${geminiResponse.status} - ${errorText}` });
        }

        const geminiData = await geminiResponse.json();
        res.json(geminiData);
    } catch (error) {
        console.error('Error proxying Gemini request:', error);
        res.status(500).json({ error: 'Failed to generate content with Gemini LLM via proxy.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
});
