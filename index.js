const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { exec } = require('child_process');
const { encoding_for_model } = require('@dqbd/tiktoken');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
const PORT = 3003;
const maxLength = 2000; // Max token count for web input
const maxHistory = 15; // Max number of prior inputs to include

const systemMessagePath = path.join(__dirname, 'system_message.txt');
let systemMessage = '';

try {
    systemMessage = fs.readFileSync(systemMessagePath, 'utf8');
    console.log('System message loaded successfully.');
} catch (error) {
    console.error('Error loading system message:', error.message);
    process.exit(1);
}

function numTokensFromString(message) {
    const encoder = encoding_for_model("gpt-4o");
    const tokens = encoder.encode(message);
    encoder.free();
    return tokens.length;
}

if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

const userHistory = {}; // In-memory store for user command history

function addUserHistory(username, command) {
    if (!userHistory[username]) {
        userHistory[username] = [];
    }
    userHistory[username].push(command);
    // Ensure history size does not exceed maxHistory
    if (userHistory[username].length > maxHistory) {
        userHistory[username].shift();
    }
}

function getUserHistory(username) {
    return userHistory[username] || [];
}

function runCommandsInLXDVM(uid, commands) {
    let [rawCommandText, explanationText] = commands.split(/\*\*Explanation:\*\*/s);
    const commandText = rawCommandText
        .slice(7)                         // Remove the first 7 characters (e.g., '''bash)
        .slice(0, -6)                     // Remove the last 6 characters (e.g., ending ''')
        .trim()                           // Trim any leading/trailing whitespace
        .replace(/<<\s+EOF/g, '<< "EOF"') // Replace '<< EOF' with '<< "EOF"'
        .replace(/'/g, "'\\''");  

    const lxdCommand = `lxc exec ${uid} -- bash -c 'set +H\n${commandText}'`;
    const explanation = explanationText ? explanationText.trim() : null;

    return new Promise((resolve, reject) => {
        exec(lxdCommand, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing commands: ${error.message}`);
                resolve(explanation);
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
                resolve(explanation);
            }
            console.log(`stdout: ${stdout}`);
            resolve(explanation);  
        });
    });
}

async function fetchWebContent(link) {
    try {
        const response = await fetch(link, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        let content = await response.text();
        while (maxLength < numTokensFromString(content)) {
            content = content.slice(0, -1000); // Reduces content by removing 1000 characters at a time 
        }
        return content;  // Ensure content length
    } catch (error) {
        console.error("Error fetching web content:", error.message);
        return null;
    }
}

async function chat(input, username) {
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const links = input.match(urlPattern);

    if (links && links.length > 0) {
        const link = links[0];
        const webContent = await fetchWebContent(link);
        console.log(webContent);

        if (webContent) {
            const snippet = webContent.slice(0, maxLength);
            input = input.replace(link, "the content of " + link + " is " + snippet);
        }
    }

    const history = getUserHistory(username);
    const messages = [
        { role: "system", content: systemMessage },
        ...history.map(command => ({ role: "user", content: command })),
        { role: "user", content: input },
    ];

    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
    });
    return completion.choices[0].message.content;
}

app.post('/execute', async (req, res) => {
    const { uid, prompt, username, contPwd } = req.body;

    if (!uid || !prompt || !username) {
        return res.status(400).json({ error: 'uid, username, and prompt are required.' });
    }
    if(prompt == 'clear'){
        userHistory[username] = [];
        return res.status(200).json({ message: 'history was cleared for'+username });
    }

    try {
        const result = await chat(prompt, username);
        var commands = result.trim();
        commands = commands.replace(/someusername/g, username);
        commands = commands.replace(/userpassword/g, contPwd);

        addUserHistory(username, prompt);

        if (commands) {
            console.log("AI output for uid:" + uid + " prompt=" + prompt + " => " + commands);
            const explanation = await runCommandsInLXDVM(uid, commands);
            return res.status(200).json({ message: explanation });
        } else {
            return res.status(500).json({ error: 'Failed to generate commands from OpenAI.' });
        }
    } catch (error) {
        console.error(`Error: ${error.message}`);
        return res.status(500).json({ error: 'An error occurred while processing your request.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
