const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { exec } = require('child_process');

const app = express();
app.use(cors());
const PORT = 3003;
const maxLength = 50000000000; //max web content

// Check for the API key in the environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


app.use(express.json());

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

    // Return a promise to ensure async handling in the route
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
            resolve(explanation);  // Resolve with explanation after execution
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
        const content = await response.text();
        return content.slice(0, maxLength); // Ensure content length
    } catch (error) {
        console.error("Error fetching web content:", error.message);
        return null;
    }
}



async function chat(input) {
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const links = input.match(urlPattern);

    if (links && links.length > 0) {
        const link = links[0];
        const webContent = await fetchWebContent(link);
        console.log(webContent);

        if (webContent) {
            const snippet = webContent.slice(0, maxLength);
            input = input.replace(link, "the content of "+link+" is "+snippet);
        }
    }
    

    const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "your output should consist only of linux commands available on ubuntu assume your output will be put directly into a vm container running apache 2 (already installed) with internet access with the exposed file folder being /var/www/html/someusername the user dose not nhave the abblility to expose more then port 80 and they have sudo privilege using userpassword. Whenever supplying code give the full command to enter using cat and EOF also every command that involves changes use echo userpassword | command.  This includes echo userpassword | cat << EOF . At the end of your commands do a **Explination:** section. make sure the command section is enclosed with ''' bash it is vital you use echo userpassword | sudo for every command. Note that for front end code you do not need to make a git repo or change file ownership. Note that you should avoid downloads in most instances ie templates for sites but if you must download a library you must export the proxy ip each time using export http_proxy=http://10.0.0.11:3128; your download command here; however downloads should be avoided unless needed. Note that  /var/www/html/someusername may not be empty and requires you to remove all files prior to executing commands unless specificaly asked. Avoid the use of subdirectories placing index.html in /var/www/html/someusername always unless specificaly asked. /var/www/html/someusername always unless specificaly asked.  There should be no explanation  before the ```bash." },
            {
                role: "user",
                content: input,
            },
        ],
    });
    return completion.choices[0].message.content;
}

// Define the route to handle the user prompt
app.post('/execute', async (req, res) => {
    const { uid, prompt, username, contPwd } = req.body;

    if (!uid || !prompt) {
        return res.status(400).json({ error: 'uid and prompt are required.' });
    }

    try {
        const result = await chat(prompt);
        var commands = result.trim();
        commands = commands.replace(/someusername/g, username);
        commands = commands.replace(/userpassword/g, contPwd);

        if (commands) {
            console.log("ai out for uid:" + uid + " prompt=" + prompt + " => " + commands);
            const explanation = await runCommandsInLXDVM(uid, commands);
            return res.status(200).json({ message: explanation });
        } else {
            return res.status(500).json({ error: 'Failed to generate commands from Gemini.' });
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
