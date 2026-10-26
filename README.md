# Short Form AI Tool Generation Pipeline
## Local Setup and Installation Guide

### 1. System Requirements

Before installing the project, ensure the following software is installed on your computer.

| Software | Purpose |
|---|---|
| Python 3.10 or 3.11+ | Runs the Python backend |
| Git | Clones the project repository |
| FFmpeg | Processes videos, extracts audio, and slices frames |
| Docker (optional) | Runs the application inside a container |

**Download links:**
- Python: https://www.python.org/downloads/
- Git: https://git-scm.com/downloads
- FFmpeg: https://www.gyan.dev/ffmpeg/builds/
- Docker: https://www.docker.com/products/docker-desktop/

**Install FFmpeg:**

Windows (PowerShell):

```powershell
winget install Gyan.FFmpeg
```

macOS:

```bash
brew install ffmpeg
```

Ubuntu/Linux:

```bash
sudo apt update
sudo apt install -y ffmpeg
```

Verify the installation:

```bash
ffmpeg -version
python --version
git --version
```

### 2. Clone the GitHub Repository

Open a terminal or PowerShell window and run:

```bash
git clone https://github.com/poojakhotsg-sudo/Task-1-2-Short-Form-AI-Tool-Generation-Pipeline-.git
```

Navigate to the project directory:

```bash
cd Task-1-2-Short-Form-AI-Tool-Generation-Pipeline-
```

If the repository is cloned into a different folder name, navigate to that folder instead.

### 3. Create a Python Virtual Environment

A virtual environment keeps the project's Python dependencies separate from other applications on your computer.

**Windows (PowerShell):**

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

If PowerShell blocks activation, you can use Command Prompt instead:

```bat
venv\Scripts\activate.bat
```

**macOS/Linux:**

```bash
python3 -m venv venv
source venv/bin/activate
```

Once activated, the environment name usually appears at the beginning of your terminal prompt.

### 4. Install Project Dependencies

Make sure the virtual environment is activated.

Install the Python packages:

```bash
pip install -r requirements.txt
```

Install the Playwright Chromium browser:

```bash
playwright install chromium
```

On supported Linux systems, install the required browser libraries using:

```bash
playwright install --with-deps chromium
```

**Important:** The repository must contain a `requirements.txt` file for the first command to work. If it does not, check the project's dependency files and install the packages specified by the project.

### 5. Configure Environment Variables

Check whether the repository contains `.env.example` or another environment configuration template.

If `.env.example` exists, create a local `.env` file.

Windows (PowerShell):

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

Open `.env` and configure the variables required by the current application.

For example, if the code explicitly requires a Groq API key, the configuration may look like this:

```env
GROQ_API_KEY=your_api_key_here
```

Only add API keys that the current code actually uses. If no AI model or AI API is configured in the project, an AI API key should not be necessary.

**Security note:** Never commit your `.env` file, API keys, or other secrets to GitHub. Keep local configuration private.

### 6. Start the Application

With the dependencies installed and configuration completed, start the FastAPI application.

Run:

```bash
python app.py
```

If the application is configured to run through Uvicorn instead, use:

```bash
uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Use the startup method supported by the current project configuration.

Once the server starts successfully, open the following URLs in your browser:

| Page | Local URL |
|---|---|
| Main application and extraction UI | http://localhost:8000 |
| Pipeline stage visualizer | http://localhost:8000/pipeline |
| Asset library | http://localhost:8000/library |

These routes must be implemented in the backend for the corresponding pages to work.

Keep the terminal running while using the application. To stop the server, press `Ctrl+C`.

### 7. Run the CLI Pipeline (Optional)

If the project supports command-line execution, you can run an extraction job directly from the terminal:

```bash
python run.py --tool "ToolName" --url "https://example.com"
```

Replace `ToolName` with the relevant tool name and the example URL with the website you want to process.

The exact command-line arguments depend on the current implementation of `run.py`.

### 8. Run the Application Using Docker (Optional)

Docker provides an alternative way to run the application in a consistent environment.

Ensure Docker Desktop or Docker Engine is installed and running.

From the project root, build the image:

```bash
docker build -t reel-pipeline .
```

Start the container:

```bash
docker run -p 8000:8000 --env-file .env reel-pipeline
```

Then open:

http://localhost:8000

The Docker image must include the required Python dependencies, FFmpeg, Playwright, Chromium, and any required system libraries. The Dockerfile should also start the application on port `8000` and bind the server to `0.0.0.0` inside the container.

### 9. Test the Application

After starting the application, perform the following checks.

- [ ] The application opens in the browser.
- [ ] The backend starts without errors.
- [ ] The pipeline visualizer and asset library load.
- [ ] A test website URL can be submitted.
- [ ] Playwright launches Chromium successfully.
- [ ] Asset extraction completes successfully.
- [ ] Extracted assets are available through the application.
- [ ] Job status and tracking work correctly.
- [ ] Video processing works if FFmpeg is required for the test.

Check the terminal logs if any step fails.

### 10. Troubleshooting Common Issues

| Problem | What to check |
|---|---|
| `python` is not recognized | Install Python and add it to PATH, or try `python3` |
| `pip install` fails | Check Python version, virtual environment, and dependency files |
| Chromium fails to launch | Run `playwright install chromium` and install required system libraries |
| FFmpeg is not found | Verify installation and ensure its executable is on PATH |
| Environment variable errors | Check `.env` and the variables referenced by the code |
| Job not found or expired | Check the job ID, backend logs, job storage, and frontend/backend API configuration |
| Extraction fails on deployment | Check browser dependencies, available memory, CPU limits, filesystem permissions, and network access |

### 11. Important Notes for Developers

1. **Local setup:** Each developer must install the required dependencies and configure their own environment.
2. **No AI API by default:** An AI model or API is only needed if the current code explicitly calls one.
3. **Frontend and backend:** If the frontend and backend run separately, ensure the frontend points to the correct backend URL.
4. **Job tracking:** If the application uses in-memory job storage, jobs created by one backend process may not be available to another process or after a restart.
5. **Deployment:** A successful local run does not guarantee successful deployment. The server must have sufficient resources and all required browser and video-processing dependencies.
6. **Secrets:** Never share API keys or credentials in the repository or documentation.

### 12. Quick Start Summary

After completing the initial setup, the typical local workflow is:

```bash
git clone https://github.com/poojakhotsg-sudo/Task-1-2-Short-Form-AI-Tool-Generation-Pipeline-.git
cd Task-1-2-Short-Form-AI-Tool-Generation-Pipeline-

python -m venv venv
```

Activate the virtual environment, then run:

```bash
pip install -r requirements.txt
playwright install chromium
python app.py
```

Finally, open http://localhost:8000 in your browser.

**Expected result:** The application should start locally, allowing you to test the website extraction workflow. Complete a test extraction before confirming that the setup works on another machine.
