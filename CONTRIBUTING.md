#  Contributing to Riverborn AI — 3D Voice Agent

Thank you for your interest in contributing to **Riverborn AI**! We welcome and appreciate contributions from the open-source community to make this real-time 3D voice agent even better.

Please take a moment to review this document before submitting your first Pull Request or opening an issue.

---

## Code of Conduct

By participating in this project, you agree to maintain a respectful, welcoming, and inclusive environment for everyone. Please treat all contributors with kindness and professionalism.

---

##  Reporting Bugs

If you find a bug, please help us by opening an issue! Before doing so, please check the existing issues to ensure it hasn't already been reported.

When opening a bug report, please include:
- A clear, descriptive title.
- Steps to reproduce the issue.
- Expected behavior vs. actual behavior.
- Error logs from your terminal (backend) or browser console (frontend).
- Your system configuration (OS, Python version, Browser name).

---

##  Suggesting Enhancements

Have an idea for a cool new feature or design improvement? We'd love to hear it!
- Open a **Feature Request** issue.
- Describe the feature you want to add and *why* it would be useful.
- If possible, include mockups or code snippets showing how it might look or work.

---

##  Local Development Setup

To set up a local development environment, please follow these steps:

1. **Fork the repository** on GitHub.
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/riverborn-ai-agent.git
   cd riverborn-ai-agent
   ```
3. **Set up upstream remote** to keep your fork in sync:
   ```bash
   git remote add upstream https://github.com/riverborn-ai/riverborn-ai-agent.git
   ```
4. **Create a virtual environment** and install dependencies:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```
5. **Configure your environment**:
   Copy `.env.example` to `.env` and fill in your keys. Make sure you place a compatible `.glb` avatar model in `static/avatar_fixed.glb`.

---

##  Code Style Guidelines

To keep the codebase clean and maintainable, please adhere to these guidelines:

### Python (Backend)
- Follow **PEP 8** style guidelines.
- Use descriptive variable and function names.
- Keep functions modular and single-purpose.
- Write docstrings for all public-facing functions and endpoints.

### Javascript & HTML (Frontend)
- Use modern **ES6+** syntax.
- Keep DOM interactions clean and optimized.
- If you change the blendshape mapping, ensure it matches the 55 ARKit names in `static/blendshapes.js` and their order in Azure TTS.
- Ensure the UI remains fully responsive and styled with high-fidelity glassmorphic styles.

---

##  Submitting a Pull Request

Ready to contribute code? Awesome! Please follow these steps:

1. **Create a new branch** for your work:
   ```bash
   git checkout -b feature/your-awesome-feature
   # or
   git checkout -b bugfix/describe-the-bug
   ```
2. **Write your code** and make sure it is tested locally.
3. **Commit your changes** with a clear and descriptive commit message:
   ```bash
   git commit -m "feat: add support for volume threshold configuration in UI"
   ```
4. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-awesome-feature
   ```
5. **Open a Pull Request** against the `main` branch of the upstream repository.
6. Provide a detailed explanation of your changes in the PR description, referencing any related issues (e.g., `Closes #12`).

---

##  Need Help?

If you have questions about the codebase, API integrations, or contribution process, please open a discussion or reach out to the project maintainers.

Happy coding! 
