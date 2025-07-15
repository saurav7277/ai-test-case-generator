import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import {
    getFirestore,
    doc,
    setDoc,
    getDoc,
    collection,
    getDocs
} from 'firebase/firestore';

// IMPORTANT: For local development, replace these with your actual Firebase config and a hardcoded appId.
// The initialAuthToken should be null for anonymous sign-in.
// Import configuration from config.js
import { firebaseConfig, appId } from './config';
const initialAuthToken = null; // Set to null for local development unless you have a custom token

// Helper function to parse Atlassian Document Format (ADF) to plain text
// This function recursively extracts text content from ADF objects.
const parseAdfToPlainText = (adf, indentLevel = 0) => {
    if (!adf || typeof adf !== 'object' || !Array.isArray(adf.content)) {
        return ''; // Return empty string if ADF is invalid or has no content
    }

    let textContent = '';
    const indent = '  '.repeat(indentLevel); // For nested lists/structures

    // Helper to parse inline content without adding block-level newlines
    const parseInlineNodes = (nodes) => {
        let inlineText = '';
        if (Array.isArray(nodes)) {
            nodes.forEach(inlineNode => {
                if (inlineNode.type === 'text' && inlineNode.text) {
                    inlineText += inlineNode.text;
                } else if (inlineNode.type === 'hardBreak') {
                    inlineText += '\n';
                }
                // Add more inline node types as needed (e.g., 'mention', 'emoji', 'strong', 'em')
                // For example, to handle bold text:
                // if (inlineNode.marks && inlineNode.marks.some(mark => mark.type === 'strong')) {
                //     inlineText = `**${inlineText}**`; // Markdown for bold
                // }
            });
        }
        return inlineText;
    };

    adf.content.forEach((node, index) => {
        switch (node.type) {
            case 'paragraph':
                textContent += parseInlineNodes(node.content);
                textContent += '\n'; // Add newline after each paragraph
                break;
            case 'bulletList':
                if (Array.isArray(node.content)) {
                    node.content.forEach(listItem => {
                        if (listItem.type === 'listItem' && Array.isArray(listItem.content)) {
                            // Recursively parse content of the list item.
                            // Trim the itemContent to remove any trailing newlines from its internal paragraphs.
                            const itemContent = parseAdfToPlainText({ content: listItem.content }, indentLevel + 1);
                            textContent += `${indent}* ${itemContent.trim()}\n`;
                        }
                    });
                }
                break;
            case 'orderedList':
                if (Array.isArray(node.content)) {
                    node.content.forEach((listItem, i) => {
                        if (listItem.type === 'listItem' && Array.isArray(listItem.content)) {
                            // Recursively parse content of the list item.
                            // Trim the itemContent to remove any trailing newlines from its internal paragraphs.
                            const itemContent = parseAdfToPlainText({ content: listItem.content }, indentLevel + 1);
                            textContent += `${indent}${i + 1}. ${itemContent.trim()}\n`;
                        }
                    });
                }
                break;
            case 'heading':
                if (Array.isArray(node.content)) {
                    const headingText = parseInlineNodes(node.content);
                    textContent += `${indent}${'#'.repeat(node.attrs.level)} ${headingText}\n\n`;
                }
                break;
            case 'codeBlock':
                if (Array.isArray(node.content) && node.content[0] && node.content[0].text) {
                    textContent += `\n${indent}\`\`\`${node.attrs.language || ''}\n${node.content[0].text}\n${indent}\`\`\`\n\n`;
                }
                break;
            case 'panel':
                if (Array.isArray(node.content)) {
                    textContent += `\n${indent}--- Panel ---\n`;
                    textContent += parseAdfToPlainText(node, indentLevel + 1); // Recursively parse panel content
                    textContent += `\n${indent}--- End Panel ---\n\n`;
                }
                break;
            case 'mediaSingle':
                // Handle image/media links if present
                if (Array.isArray(node.content) && node.content[0] && node.content[0].type === 'media' && node.content[0].attrs && node.content[0].attrs.url) {
                    textContent += `${indent}[Image: ${node.content[0].attrs.url}]\n\n`;
                }
                break;
            case 'rule':
                textContent += `${indent}---\n\n`; // Horizontal rule
                break;
            default:
                // For any other unhandled block types, try to parse their content recursively
                if (Array.isArray(node.content)) {
                    textContent += parseAdfToPlainText(node, indentLevel);
                }
                break;
        }
    });
    return textContent.trim();
};


// Main React App component
const App = () => {
    // Application ID constant
    const appId = 'ai-test-case-generator-app';  // Add this constant

    // State for Firebase and user authentication
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // State for Jira configuration
    const [jiraUrl, setJiraUrl] = useState('');
    const [jiraUsername, setJiraUsername] = useState('');
    const [jiraApiToken, setJiraApiToken] = useState('');
    const [jiraConfigLoaded, setJiraConfigLoaded] = useState(false);

    // State for Jira issue details and LLM outputs
    const [issueId, setIssueId] = useState('');
    const [jiraDetails, setJiraDetails] = useState(null);
    const [testCases, setTestCases] = useState([]);
    const [issueSummary, setIssueSummary] = useState(''); // New state for LLM summary
    const [acceptanceCriteria, setAcceptanceCriteria] = useState([]); // New state for LLM acceptance criteria
    const [editingCell, setEditingCell] = useState(null); // Track which cell is being edited
    const [savedTestCases, setSavedTestCases] = useState({}); // Store saved test cases by Jira ID
    const [viewingSavedTestCases, setViewingSavedTestCases] = useState(false); // Toggle saved test cases view

    // State for UI feedback
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [infoMessage, setInfoMessage] = useState(''); // New state for informational messages
    const [llmLoadingSummary, setLlmLoadingSummary] = useState(false); // Specific loading for summary
    const [llmLoadingAC, setLlmLoadingAC] = useState(false); // Specific loading for acceptance criteria
    const [llmLoadingTC, setLlmLoadingTC] = useState(false); // Specific loading for test cases

    // Initialize Firebase and handle authentication
    useEffect(() => {
        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);

            setDb(firestoreDb);
            setAuth(firebaseAuth);

            // Listen for auth state changes
            const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else {
                    // Sign in anonymously if no initial token or user
                    if (!initialAuthToken) {
                        try {
                            const anonymousUser = await signInAnonymously(firebaseAuth);
                            setUserId(anonymousUser.user.uid);
                        } catch (error) {
                            console.error("Error signing in anonymously:", error);
                            setErrorMessage("Failed to sign in. Please try again.");
                        }
                    }
                }
                setIsAuthReady(true);
            });

            // Sign in with custom token if provided
            if (initialAuthToken) {
                signInWithCustomToken(firebaseAuth, initialAuthToken)
                    .then((userCredential) => {
                        setUserId(userCredential.user.uid);
                    })
                    .catch((error) => {
                        console.error("Error signing in with custom token:", error);
                        setErrorMessage("Authentication failed. Please refresh the page.");
                        // Fallback to anonymous if custom token fails
                        signInAnonymously(firebaseAuth)
                            .then(anonUser => setUserId(anonUser.user.uid))
                            .catch(anonError => console.error("Anonymous sign-in failed:", anonError));
                    });
            }

            return () => unsubscribe(); // Cleanup auth listener
        } catch (error) {
            console.error("Firebase initialization error:", error);
            setErrorMessage("Failed to initialize the application. Please check console for details.");
        }
    }, []);

    // Load Jira configuration from Firestore when auth is ready and userId is available
    useEffect(() => {
        const loadJiraConfig = async () => {
            if (db && userId && isAuthReady) {
                try {
                    const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/jira_config/config_doc`);
                    const docSnap = await getDoc(configDocRef);
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        setJiraUrl(data.jiraUrl || '');
                        setJiraUsername(data.jiraUsername || '');
                        setJiraApiToken(data.jiraApiToken || '');
                        setSuccessMessage('Jira configuration loaded successfully!');
                        setInfoMessage(''); // Clear info message if config is found
                    } else {
                        // Changed this to an info message, not a success message
                        setInfoMessage('No saved Jira configuration found. Please enter your details below to get started.');
                        setSuccessMessage(''); // Ensure success message is clear
                    }
                } catch (error) {
                    console.error("Error loading Jira config:", error);
                    setErrorMessage('Failed to load Jira configuration. Please try again.');
                    setInfoMessage(''); // Clear info message on error
                } finally {
                    setJiraConfigLoaded(true);
                }
            }
        };
        loadJiraConfig();
    }, [db, userId, isAuthReady]);

    // Save Jira configuration to Firestore
    const saveJiraConfig = async () => {
        if (!db || !userId) {
            setErrorMessage('Application not ready. Please wait.');
            return;
        }
        if (!jiraUrl || !jiraUsername || !jiraApiToken) {
            setErrorMessage('All Jira configuration fields are required to save.');
            return;
        }

        setLoading(true);
        setErrorMessage('');
        setSuccessMessage('');
        setInfoMessage(''); // Clear info message when saving
        try {
            const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/jira_config/config_doc`);
            await setDoc(configDocRef, {
                jiraUrl,
                jiraUsername,
                jiraApiToken,
                lastUpdated: new Date().toISOString()
            });
            setSuccessMessage('Jira configuration saved successfully!');
        } catch (error) {
            console.error("Error saving Jira config:", error);
            setErrorMessage('Failed to save Jira configuration. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // Function to fetch Jira issue details
    const fetchJiraIssueDetails = async (issueId) => {
        if (!jiraUrl || !jiraUsername || !jiraApiToken) {
            setErrorMessage('Please provide Jira URL, Username, and API Token.');
            return null;
        }

        setLoading(true); // General loading for fetch operation
        setErrorMessage('');
        setSuccessMessage('');
        setInfoMessage(''); // Clear info message when fetching
        setJiraDetails(null); // Clear previous details
        setTestCases([]); // Clear previous LLM outputs
        setIssueSummary('');
        setAcceptanceCriteria([]);

        try {
            // Change the fetch call to your backend proxy
            const response = await fetch('http://localhost:3001/api/jira', { // <-- IMPORTANT: Update URL
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ // <-- Send all necessary data in the body
                    jiraUrl,
                    jiraUsername,
                    jiraApiToken,
                    issueId
                })
            });

            if (!response.ok) {
                const errorJson = await response.json(); // Proxy sends JSON error
                throw new Error(errorJson.error || `Jira API Error: ${response.status}`);
            }

            const data = await response.json();
            setJiraDetails(data);
            setSuccessMessage(`Successfully fetched Jira issue ${issueId}.`);
            return data;
        } catch (error) {
            console.error("Error fetching Jira issue:", error);
            setErrorMessage(`Failed to fetch Jira issue: ${error.message}. Please check Issue ID and Jira credentials.`);
            setJiraDetails(null);
            return null;
        } finally {
            setLoading(false);
        }
    };

    // Function to format Jira details for LLM prompt
    const formatJiraDetailsForLLM = (jiraData) => {
        if (!jiraData) return '';

        let formattedString = `Jira Issue Details:\n`;
        formattedString += `Issue Key: ${jiraData.key}\n`;
        formattedString += `Summary: ${jiraData.fields.summary}\n`;
        // Use parseAdfToPlainText for description
        formattedString += `Description: ${jiraData.fields.description ? parseAdfToPlainText(jiraData.fields.description) : 'N/A'}\n`;

        // --- UPDATED: Add Acceptance Criteria to LLM prompt (using customfield_10056) ---
        const acceptanceCriteriaField = jiraData.fields.customfield_10056;
        if (acceptanceCriteriaField) {
            formattedString += `Acceptance Criteria:\n${parseAdfToPlainText(acceptanceCriteriaField)}\n`; // Added newline here
        } else {
            formattedString += `Acceptance Criteria: N/A\n`;
        }
        // --- END UPDATED ---

        formattedString += `Status: ${jiraData.fields.status.name}\n`;
        formattedString += `Priority: ${jiraData.fields.priority ? jiraData.fields.priority.name : 'N/A'}\n`;
        formattedString += `Assignee: ${jiraData.fields.assignee ? jiraData.fields.assignee.displayName : 'Unassigned'}\n`;
        formattedString += `Reporter: ${jiraData.fields.reporter ? jiraData.fields.reporter.displayName : 'N/A'}\n`;
        formattedString += `Created: ${new Date(jiraData.fields.created).toLocaleString()}\n`;
        formattedString += `Updated: ${new Date(jiraData.fields.updated).toLocaleString()}\n`;

        if (jiraData.fields.components && jiraData.fields.components.length > 0) {
            formattedString += `Components: ${jiraData.fields.components.map(c => c.name).join(', ')}\n`;
        }
        if (jiraData.fields.labels && jiraData.fields.labels.length > 0) {
            formattedString += `Labels: ${jiraData.fields.labels.join(', ')}\n`;
        }
        if (jiraData.fields.comment && jiraData.fields.comment.comments && jiraData.fields.comment.comments.length > 0) {
            formattedString += `Comments:\n`;
            jiraData.fields.comment.comments.forEach(comment => {
                // Use parseAdfToPlainText for comment body
                formattedString += `  - ${comment.author.displayName}: ${parseAdfToPlainText(comment.body)}\n`;
            });
        }
        return formattedString;
    };

    // Function to generate test cases using Gemini LLM
    const generateTestCases = async () => {
        if (!jiraDetails) {
            setErrorMessage('Please fetch Jira issue details first.');
            return;
        }
        setLlmLoadingTC(true);
        setErrorMessage('');
        setSuccessMessage('');
        setInfoMessage(''); // Clear info message when generating test cases
        setTestCases([]); // Clear previous test cases

        try {
            const formattedDetails = formatJiraDetailsForLLM(jiraDetails);
            const prompt = `Based on the following Jira Issue Details, generate a comprehensive set of test cases. Include positive, negative, and edge-case scenarios. Provide the output as a JSON array of objects, where each object has 'title' (string), 'type' (string, e.g., 'Positive', 'Negative', 'Edge Case'), and 'steps' (an array of strings).

            ${formattedDetails}

            Example JSON format:
            [
              {
                "title": "Verify successful login with valid credentials",
                "type": "Positive",
                "steps": [
                  "Navigate to login page.",
                  "Enter valid username and password.",
                  "Click login button.",
                  "Verify user is redirected to dashboard."
                ]
              }
            ]
            `;

            const payload = {
                prompt: prompt, // Send prompt directly
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                "title": { "type": "STRING" },
                                "type": { "type": "STRING" },
                                "steps": {
                                    "type": "ARRAY",
                                    "items": { "type": "STRING" }
                                }
                            },
                            "propertyOrdering": ["title", "type", "steps"]
                        }
                    }
                }
            };

            // Change the fetch call to your backend proxy
            const response = await fetch('http://localhost:3001/api/gemini', { // <-- IMPORTANT: Update URL
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorJson = await response.json();
                throw new Error(errorJson.error || `Gemini API Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const jsonString = result.candidates[0].content.parts[0].text;
                const parsedTestCases = JSON.parse(jsonString);
                setTestCases(parsedTestCases);
            } else {
                setErrorMessage('Gemini LLM did not return expected test case format.');
            }
        } catch (error) {
            console.error("Error generating test cases:", error);
            setErrorMessage(`Failed to generate test cases: ${error.message}`);
        } finally {
            setLlmLoadingTC(false);
        }
    };

    // Function to summarize Jira issue using Gemini LLM
    const summarizeJiraIssue = async () => {
        if (!jiraDetails) {
            setErrorMessage('Please fetch Jira issue details first to summarize.');
            return;
        }
        setLlmLoadingSummary(true);
        setErrorMessage('');
        setSuccessMessage('');
        setInfoMessage(''); // Clear info message when summarizing
        setIssueSummary(''); // Clear previous summary

        try {
            const formattedDetails = formatJiraDetailsForLLM(jiraDetails);
            const prompt = `Summarize the following Jira Issue Details concisely in 2-3 sentences.
            ${formattedDetails}
            `;

            const payload = { prompt: prompt }; // Simplified payload for text generation

            const response = await fetch('http://localhost:3001/api/gemini', { // <-- IMPORTANT: Update URL
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorJson = await response.json();
                throw new Error(errorJson.error || `Gemini API Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                setIssueSummary(result.candidates[0].content.parts[0].text);
                setSuccessMessage('Issue summary generated successfully!');
            } else {
                setErrorMessage('Gemini LLM did not return a summary.');
            }
        } catch (error) {
            console.error("Error summarizing issue:", error);
            setErrorMessage(`Failed to summarize issue: ${error.message}`);
        } finally {
            setLlmLoadingSummary(false);
        }
    };

    // Function to suggest acceptance criteria using Gemini LLM
    const suggestAcceptanceCriteria = async () => {
        if (!jiraDetails) {
            setErrorMessage('Please fetch Jira issue details first to suggest acceptance criteria.');
            return;
        }
        setLlmLoadingAC(true);
        setErrorMessage('');
        setSuccessMessage('');
        setInfoMessage(''); // Clear info message when suggesting AC
        setAcceptanceCriteria([]); // Clear previous AC

        try {
            const formattedDetails = formatJiraDetailsForLLM(jiraDetails);
            const prompt = `Based on the following Jira Issue Details, suggest a list of acceptance criteria. Provide the output as a JSON array of strings.

            ${formattedDetails}

            Example JSON format:
            [
              "User can log in with valid credentials.",
              "Error message is displayed for invalid credentials.",
              "Password reset functionality works as expected."
            ]
            `;

            const payload = {
                prompt: prompt,
                responseSchema: { // Send responseSchema directly
                    type: "ARRAY",
                    items: { "type": "STRING" }
                }
            };

            const response = await fetch('http://localhost:3001/api/gemini', { // <-- IMPORTANT: Update URL
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorJson = await response.json();
                throw new Error(errorJson.error || `Gemini API Error: ${response.status}`);
            }

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const jsonString = result.candidates[0].content.parts[0].text;
                const parsedAC = JSON.parse(jsonString);
                setAcceptanceCriteria(parsedAC);
                setSuccessMessage('Acceptance criteria suggested successfully!');
            } else {
                setErrorMessage('Gemini LLM did not return acceptance criteria in expected format.');
            }
        } catch (error) {
            console.error("Error suggesting acceptance criteria:", error);
            setErrorMessage(`Failed to suggest acceptance criteria: ${error.message}`);
        } finally {
            setLlmLoadingAC(false);
        }
    };

    // Handle cell editing
    const handleCellEdit = (index, field, value) => {
        const updatedTestCases = [...testCases];
        updatedTestCases[index] = {
            ...updatedTestCases[index],
            [field]: value
        };
        setTestCases(updatedTestCases);
        setEditingCell(null);
    };

    // Save test cases for current Jira issue
    const saveTestCases = async () => {
        if (!issueId || !testCases.length) return;
        try {
            const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/test_cases/${issueId}`);
            const dataToSave = {
                testCases,
                savedAt: new Date().toISOString(),
                issueKey: jiraDetails.key,
                summary: jiraDetails.fields.summary
            };
            
            await setDoc(configDocRef, dataToSave);
            
            setSavedTestCases(prev => ({
                ...prev,
                [issueId]: {
                    testCases,
                    summary: jiraDetails.fields.summary
                }
            }));
            
            setSuccessMessage('Test cases saved successfully!');
        } catch (error) {
            console.error("Error saving test cases:", error);
            setErrorMessage('Failed to save test cases. Please try again.');
        }
    };

    // Load saved test cases for a Jira issue
    const loadSavedTestCases = async (jiraId) => {
        try {
            const testCasesDocRef = doc(db, `artifacts/${appId}/users/${userId}/test_cases/${jiraId}`);
            const docSnap = await getDoc(testCasesDocRef);
            if (docSnap.exists()) {
                const data = docSnap.data();
                return data;
            }
            return null;
        } catch (error) {
            console.error("Error loading saved test cases:", error);
            setErrorMessage('Failed to load saved test cases.');
            return null;
        }
    };

    // Handle form submission (only fetches Jira details now)
    const handleFetchJira = async (e) => {
        e.preventDefault();
        if (!issueId) {
            setErrorMessage('Please enter a Jira Issue ID.');
            return;
        }
        await fetchJiraIssueDetails(issueId);
        
        // Try to load saved test cases
        const savedData = await loadSavedTestCases(issueId);
        if (savedData) {
            setInfoMessage('Found saved test cases for this issue.');
        }
    };

    // Render loading state while Firebase is initializing
    if (!isAuthReady || !jiraConfigLoaded) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
                <div className="text-center text-gray-700">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
                    <p>Loading application...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 p-4 sm:p-6 lg:p-8 font-inter text-gray-800">
            <div className="max-w-6xl mx-auto bg-white shadow-xl rounded-2xl p-6 sm:p-8 lg:p-10 border border-gray-200">
                <div className="flex flex-col items-center mb-8">
                    <h1 className="text-4xl font-extrabold text-purple-800 mb-6">AI-Test-Case-Generator</h1>
                    <button
                        onClick={async () => {
    if (!db || !userId) {
        console.error('Database or userId not initialized');
        setErrorMessage('Application not ready. Please wait.');
        return;
    }
    
    setViewingSavedTestCases(true);
    setLoading(true);
    try {
        console.log('Fetching test cases for user:', userId);
        const testCasesPath = `artifacts/${appId}/users/${userId}/test_cases`;
        console.log('Using Firestore path:', testCasesPath);
        
        const testCasesCollectionRef = collection(db, testCasesPath);
        const testCasesSnapshot = await getDocs(testCasesCollectionRef);
        const testCasesData = {};
        
        console.log('Number of documents found:', testCasesSnapshot.size);
        
        testCasesSnapshot.forEach((doc) => {
            const data = doc.data();
            console.log('Document data for', doc.id, ':', data);
            // Make sure we have the required data
            if (data.testCases) {
                testCasesData[doc.id] = data;
            }
        });
        
        console.log('Final test cases data:', testCasesData);
        setSavedTestCases(testCasesData);
    } catch (error) {
        console.error("Error loading saved test cases:", error);
        setErrorMessage('Failed to load saved test cases.');
    } finally {
        setLoading(false);
    }
}}
                        className="px-6 py-3 bg-purple-600 text-white font-semibold rounded-lg shadow-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5"
                    >
                        📋 View Saved Test Cases
                    </button>
                </div>

                {/* User ID Display */}
                {userId && (
                    <div className="bg-blue-50 border border-blue-200 text-blue-800 p-3 rounded-lg mb-6 text-sm">
                        <p className="font-semibold">Your User ID (for data persistence):</p>
                        <p className="break-all">{userId}</p>
                    </div>
                )}

                {/* Saved Test Cases View */}
                {viewingSavedTestCases && (
                    <div className="mb-8 p-6 bg-white rounded-xl border border-gray-200 shadow-sm">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-bold text-gray-800">Saved Test Cases</h2>
                            <button
                                onClick={() => setViewingSavedTestCases(false)}
                                className="text-gray-600 hover:text-gray-800"
                            >
                                ✕ Close
                            </button>
                        </div>
                        {loading ? (
                            <div className="text-center py-8">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
                                <p className="text-gray-600">Loading saved test cases...</p>
                            </div>
                        ) : Object.entries(savedTestCases).length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <p className="text-lg mb-2">No saved test cases found</p>
                                <p className="text-sm">Generate and save some test cases to see them here.</p>
                            </div>
                        ) : (
                            Object.entries(savedTestCases).map(([jiraId, data]) => (
                            <div key={jiraId} className="mb-6">
                                <h3 className="text-lg font-semibold text-gray-700 mb-2">
                                    {jiraId} - {data.summary || 'Test Cases'}
                                </h3>
                                <div className="overflow-x-auto rounded-lg border border-gray-200">
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">S.No.</th>
                                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Steps</th>
                                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {data.testCases.map((testCase, index) => (
                                                <tr key={index}>
                                                    <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-900">{index + 1}</td>
                                                    <td className="px-6 py-4 text-sm text-gray-900">{testCase.title}</td>
                                                    <td className="px-6 py-4 text-sm text-gray-900">
                                                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                                            testCase.type === 'Positive' ? 'bg-blue-100 text-blue-800' :
                                                            testCase.type === 'Negative' ? 'bg-red-100 text-red-800' :
                                                            testCase.type === 'Edge Case' ? 'bg-yellow-100 text-yellow-800' :
                                                            'bg-gray-100 text-gray-800'
                                                        }`}>
                                                            {testCase.type}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-900">
                                                        <ul className="list-disc list-inside">
                                                            {testCase.steps.map((step, stepIndex) => (
                                                                <li key={stepIndex}>{step}</li>
                                                            ))}
                                                        </ul>
                                                    </td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                                        <button
                                                            onClick={() => {
                                                                setTestCases([...testCases, testCase]);
                                                                setViewingSavedTestCases(false);
                                                                setSuccessMessage('Test case added to current set!');
                                                            }}
                                                            className="text-blue-600 hover:text-blue-800"
                                                        >
                                                            Add to Current Set
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))
                        )}
                    </div>
                )}

                {/* Jira Configuration Section */}
                <div className="mb-8 p-6 bg-gray-50 rounded-xl border border-gray-100 shadow-sm">
                    {/* Display Jira config error and success messages above the header */}
                    {errorMessage && errorMessage.includes('Jira configuration') && (
                        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg relative mb-6" role="alert">
                            <strong className="font-bold">Error!</strong>
                            <span className="block sm:inline"> {errorMessage}</span>
                        </div>
                    )}
                    {successMessage && successMessage.includes('Jira configuration') && (
                        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded-lg relative mb-6" role="alert">
                            <strong className="font-bold">Success!</strong>
                            <span className="block sm:inline"> {successMessage}</span>
                        </div>
                    )}
                    {infoMessage && infoMessage.includes('Jira configuration') && (
                        <div className="bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded-lg relative mb-6" role="alert">
                            <strong className="font-bold">Info:</strong>
                            <span className="block sm:inline"> {infoMessage}</span>
                        </div>
                    )}
                    <h2 className="text-2xl font-bold text-gray-700 mb-4">Jira Configuration</h2>
                    <p className="text-sm text-gray-600 mb-4">
                        Enter your Jira instance URL, username (email), and API token. This will be securely saved for future use.
                        <br/>
                        <a href="https://support.atlassian.com/atlassian-account/docs/manage-api-tokens/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                            How to generate a Jira API token
                        </a>
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                        <div>
                            <label htmlFor="jiraUrl" className="block text-sm font-medium text-gray-700 mb-1">Jira URL (e.g., https://your-company.atlassian.net)</label>
                            <input
                                type="text"
                                id="jiraUrl"
                                value={jiraUrl}
                                onChange={(e) => setJiraUrl(e.target.value)}
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 transition duration-200"
                                placeholder="https://your-company.atlassian.net"
                            />
                        </div>
                        <div>
                            <label htmlFor="jiraUsername" className="block text-sm font-medium text-gray-700 mb-1">Jira Username (Email)</label>
                            <input
                                type="email"
                                id="jiraUsername"
                                value={jiraUsername}
                                onChange={(e) => setJiraUsername(e.target.value)}
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 transition duration-200"
                                placeholder="your.email@example.com"
                            />
                        </div>
                        <div>
                            <label htmlFor="jiraApiToken" className="block text-sm font-medium text-gray-700 mb-1">Jira API Token</label>
                            <input
                                type="password"
                                id="jiraApiToken"
                                value={jiraApiToken}
                                onChange={(e) => setJiraApiToken(e.target.value)}
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 transition duration-200"
                                placeholder="Your Jira API Token"
                            />
                        </div>
                    </div>
                    <button
                        onClick={saveJiraConfig}
                        className="w-full md:w-auto px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5"
                        disabled={loading}
                    >
                        {loading ? 'Saving...' : 'Save Jira Configuration'}
                    </button>
                </div>

                {/* Main Issue Input Section */}
                <form onSubmit={handleFetchJira} className="mb-8 p-6 bg-white rounded-xl border border-gray-100 shadow-md">
                    <h2 className="text-2xl font-bold text-gray-700 mb-4">Fetch Jira Issue Details</h2>
                    {/* Display Jira issue-related messages */}
                    {errorMessage && !errorMessage.includes('configuration') && errorMessage.includes('Jira') && (
                        <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg relative" role="alert">
                            <strong className="font-bold">Error!</strong>
                            <span className="block sm:inline"> {errorMessage}</span>
                        </div>
                    )}
                    {successMessage && !successMessage.includes('configuration') && successMessage.includes('Jira') && (
                        <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded-lg relative" role="alert">
                            <strong className="font-bold">Success!</strong>
                            <span className="block sm:inline"> {successMessage}</span>
                        </div>
                    )}
                    {infoMessage && !infoMessage.includes('configuration') && infoMessage.includes('Jira') && (
                        <div className="mb-4 bg-blue-100 border border-blue-400 text-blue-700 px-4 py-3 rounded-lg relative" role="alert">
                            <strong className="font-bold">Info:</strong>
                            <span className="block sm:inline"> {infoMessage}</span>
                        </div>
                    )}
                    <div className="flex flex-col sm:flex-row gap-4 mb-4">
                        <div className="flex-grow">
                            <label htmlFor="issueId" className="block text-sm font-medium text-gray-700 mb-1">Jira Issue ID (e.g., PROJ-123)</label>
                            <input
                                type="text"
                                id="issueId"
                                value={issueId}
                                onChange={(e) => setIssueId(e.target.value.toUpperCase())}
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-purple-500 focus:border-purple-500 transition duration-200"
                                placeholder="Enter Jira Issue ID (e.g., PROJ-123)"
                                required
                            />
                        </div>
                        <button
                            type="submit"
                            className="w-full sm:w-auto px-8 py-3 mt-auto bg-purple-600 text-white font-semibold rounded-lg shadow-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5"
                            disabled={loading || !jiraConfigLoaded}
                        >
                            {loading ? (
                                <span className="flex items-center justify-center">
                                    <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Fetching...
                                </span>
                            ) : (
                                'Fetch Jira Issue'
                            )}
                        </button>
                    </div>
                </form>

                {/* Messages */}
                {/* ...existing code... */}

                {/* Jira Details Display */}
                {jiraDetails && (
                    <div className="mb-8 p-6 bg-blue-50 rounded-xl border border-blue-100 shadow-sm">
                        <h2 className="text-2xl font-bold text-blue-700 mb-4">Jira Issue Details: {jiraDetails.key}</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-gray-700">
                            <p><strong>Summary:</strong> {jiraDetails.fields.summary}</p>
                            <p><strong>Status:</strong> <span className={`px-2 py-1 rounded-full text-sm font-semibold ${
                                jiraDetails.fields.status.name === 'Done' ? 'bg-green-200 text-green-800' :
                                jiraDetails.fields.status.name === 'In Progress' ? 'bg-yellow-200 text-yellow-800' :
                                'bg-gray-200 text-gray-800'
                            }`}>{jiraDetails.fields.status.name}</span></p>
                            <p><strong>Priority:</strong> {jiraDetails.fields.priority ? jiraDetails.fields.priority.name : 'N/A'}</p>
                            <p><strong>Assignee:</strong> {jiraDetails.fields.assignee ? jiraDetails.fields.assignee.displayName : 'Unassigned'}</p>
                            <p><strong>Reporter:</strong> {jiraDetails.fields.reporter ? jiraDetails.fields.reporter.displayName : 'N/A'}</p>
                            <p className="col-span-1 md:col-span-2"><strong>Description:</strong> {jiraDetails.fields.description ? parseAdfToPlainText(jiraDetails.fields.description) : 'No description provided.'}</p>
                            {/* --- UPDATED: Display Acceptance Criteria with pre-wrap and line break --- */}
                            <p className="col-span-1 md:col-span-2">
                                <strong>Acceptance Criteria:</strong> <br/> <span style={{ whiteSpace: 'pre-wrap' }}>{
                                    jiraDetails.fields.customfield_10056 ?
                                    parseAdfToPlainText(jiraDetails.fields.customfield_10056) :
                                    'N/A'
                                }</span>
                            </p>
                            {/* --- END UPDATED --- */}
                            {jiraDetails.fields.components && jiraDetails.fields.components.length > 0 && (
                                <p className="col-span-1 md:col-span-2"><strong>Components:</strong> {jiraDetails.fields.components.map(c => c.name).join(', ')}</p>
                            )}
                            {jiraDetails.fields.labels && jiraDetails.fields.labels.length > 0 && (
                                <p className="col-span-1 md:col-span-2"><strong>Labels:</strong> {jiraDetails.fields.labels.join(', ')}</p>
                            )}
                            {jiraDetails.fields.comment && jiraDetails.fields.comment.comments && jiraDetails.fields.comment.comments.length > 0 && (
                                <div className="col-span-1 md:col-span-2">
                                    <strong>Comments:</strong>
                                    <ul className="list-disc list-inside mt-2">
                                        {jiraDetails.fields.comment.comments.map((comment, index) => (
                                            <li key={index} className="mb-1 text-sm">
                                                <span className="font-semibold">{comment.author.displayName}:</span> {
                                                    parseAdfToPlainText(comment.body)
                                                }
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>

                        {/* LLM Action Buttons */}
                        <div className="mt-6 flex flex-wrap gap-4 justify-center">
                            <button
                                onClick={generateTestCases}
                                className="px-6 py-3 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5 flex items-center justify-center"
                                disabled={llmLoadingTC || llmLoadingSummary || llmLoadingAC}
                            >
                                {llmLoadingTC ? (
                                    <span className="flex items-center justify-center">
                                        <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Generating...
                                    </span>
                                ) : '✨ Generate Test Cases'}
                            </button>
                            <button
                                onClick={summarizeJiraIssue}
                                className="px-6 py-3 bg-yellow-600 text-white font-semibold rounded-lg shadow-md hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5 flex items-center justify-center"
                                disabled={llmLoadingTC || llmLoadingSummary || llmLoadingAC}
                            >
                                {llmLoadingSummary ? (
                                    <span className="flex items-center justify-center">
                                        <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Summarizing...
                                    </span>
                                ) : '✨ Summarize Issue'}
                            </button>
                            <button
                                onClick={suggestAcceptanceCriteria}
                                className="px-6 py-3 bg-teal-600 text-white font-semibold rounded-lg shadow-md hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 transition duration-300 ease-in-out transform hover:-translate-y-0.5 flex items-center justify-center"
                                disabled={llmLoadingTC || llmLoadingSummary || llmLoadingAC}
                            >
                                {llmLoadingAC ? (
                                    <span className="flex items-center justify-center">
                                        <svg className="animate-spin h-5 w-5 mr-3 text-white" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Suggesting...
                                    </span>
                                ) : '✨ Suggest Acceptance Criteria'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Issue Summary Display */}
                {issueSummary && (
                    <div className="mb-8 p-6 bg-yellow-50 rounded-xl border border-yellow-100 shadow-sm">
                        <h2 className="text-2xl font-bold text-yellow-700 mb-4">Issue Summary</h2>
                        <p className="text-gray-700">{issueSummary}</p>
                    </div>
                )}

                {/* Acceptance Criteria Display */}
                {acceptanceCriteria.length > 0 && (
                    <div className="mb-8 p-6 bg-teal-50 rounded-xl border border-teal-100 shadow-sm">
                        <h2 className="text-2xl font-bold text-teal-700 mb-4">Suggested Acceptance Criteria</h2>
                        <ul className="list-disc list-inside text-gray-700">
                            {acceptanceCriteria.map((criterion, index) => (
                                <li key={index} className="mb-1">{criterion}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Message Displays */}
                {infoMessage && !infoMessage.includes('Jira configuration') && (
                    <div className="mb-4 p-4 rounded-md bg-blue-50 border border-blue-200 shadow-sm text-blue-700 flex items-center justify-between">
                        <div className="flex items-center">
                            <span className="text-blue-500 mr-2">✨</span>
                            <span className="font-medium">Great news!</span>
                            <span className="ml-2">We found previously saved test cases for this issue.</span>
                        </div>
                        <button
                            onClick={() => setViewingSavedTestCases(true)}
                            className="ml-4 px-4 py-1.5 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200 font-medium transition-all duration-200 flex items-center group"
                        >
                            <span>📋</span>
                            <span className="ml-2 group-hover:translate-x-0.5 transform transition-transform duration-200">View Test Cases</span>
                        </button>
                    </div>
                )}

                {/* Test Cases Display */}
                {testCases.length > 0 && (
                    <div className="p-6 bg-green-50 rounded-xl border border-green-100 shadow-sm">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-2xl font-bold text-green-700">Generated Test Cases</h2>
                            <div className="flex space-x-4">
                                <button
                                    onClick={saveTestCases}
                                    className="px-6 py-3 bg-green-600 text-white font-semibold rounded-lg shadow-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 transition duration-300 ease-in-out"
                                    disabled={!testCases.length || !issueId}
                                >
                                    💾 Save Test Cases
                                </button>
                                <button
                                    onClick={() => {
                                        // Prepare data for Excel
                                        const excelData = testCases.map((tc, idx) => ({
                                            'S.No.': idx + 1,
                                            Title: tc.title,
                                            Type: tc.type,
                                            Steps: tc.steps.join('\n')
                                        }));
                                        const worksheet = XLSX.utils.json_to_sheet(excelData);
                                        const workbook = XLSX.utils.book_new();
                                        XLSX.utils.book_append_sheet(workbook, worksheet, 'TestCases');
                                        XLSX.writeFile(workbook, 'generated_test_cases.xlsx');
                                    }}
                                    className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition duration-300 ease-in-out"
                                >
                                    ⬇️ Download as Excel
                                </button>
                            </div>
                        </div>
                        {successMessage && !successMessage.includes('Jira') && (
                            <div className="mb-4 p-4 rounded-md bg-green-50 text-green-700">
                                {successMessage}
                            </div>
                        )}
                        {infoMessage && !infoMessage.includes('Jira') && (
                            <div className="mb-4 p-4 rounded-md bg-blue-50 text-blue-700 flex items-center justify-between">
                                <span>{infoMessage}</span>
                                <button
                                    onClick={() => setViewingSavedTestCases(true)}
                                    className="ml-2 text-blue-600 hover:text-blue-800 underline"
                                >
                                    View Saved Cases
                                </button>
                            </div>
                        )}
                        <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-100">
                                    <tr>
                                        <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider rounded-tl-lg">S.No.</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Steps</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {testCases.map((testCase, index) => (
                                        <tr key={index} className="hover:bg-gray-50">
                                            <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{index + 1}</td>
                                            <td className="px-6 py-4 whitespace-normal text-sm font-medium text-gray-900" 
                                                onClick={() => setEditingCell({ index, field: 'title' })}>
                                                {editingCell?.index === index && editingCell?.field === 'title' ? (
                                                    <input
                                                        type="text"
                                                        className="w-full p-1 border rounded"
                                                        value={testCase.title}
                                                        onChange={(e) => handleCellEdit(index, 'title', e.target.value)}
                                                        onBlur={() => setEditingCell(null)}
                                                        autoFocus
                                                    />
                                                ) : (
                                                    <div className="cursor-pointer">{testCase.title}</div>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                {editingCell?.index === index && editingCell?.field === 'type' ? (
                                                    <select
                                                        className="w-full p-1 border rounded"
                                                        value={testCase.type}
                                                        onChange={(e) => handleCellEdit(index, 'type', e.target.value)}
                                                        onBlur={() => setEditingCell(null)}
                                                        autoFocus
                                                    >
                                                        <option value="Positive">Positive</option>
                                                        <option value="Negative">Negative</option>
                                                        <option value="Edge Case">Edge Case</option>
                                                    </select>
                                                ) : (
                                                    <span 
                                                        onClick={() => setEditingCell({ index, field: 'type' })}
                                                        className={`cursor-pointer px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                                            testCase.type === 'Positive' ? 'bg-blue-100 text-blue-800' :
                                                            testCase.type === 'Negative' ? 'bg-red-100 text-red-800' :
                                                            testCase.type === 'Edge Case' ? 'bg-yellow-100 text-yellow-800' :
                                                            'bg-gray-100 text-gray-800'
                                                        }`}
                                                    >
                                                        {testCase.type}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 whitespace-normal text-sm text-gray-900"
                                                onClick={() => setEditingCell({ index, field: 'steps' })}>
                                                {editingCell?.index === index && editingCell?.field === 'steps' ? (
                                                    <textarea
                                                        className="w-full p-1 border rounded"
                                                        value={testCase.steps.join('\n')}
                                                        onChange={(e) => handleCellEdit(index, 'steps', e.target.value.split('\n'))}
                                                        onBlur={() => setEditingCell(null)}
                                                        autoFocus
                                                    />
                                                ) : (
                                                    <ul className="list-disc list-inside cursor-pointer">
                                                        {testCase.steps.map((step, stepIndex) => (
                                                            <li key={stepIndex}>{step}</li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default App;
