# AI SRS Document Generator

An AI-powered web application that helps developers create professional
Software Requirements Specification (SRS) documents from a simple software idea.

## 🚀 Project Overview

The user provides:

1. Project Name
2. Client's Software Idea

The AI analyzes the idea and asks clarification questions when important
information is missing.

After the user answers the questions, the AI generates a structured and
professional SRS document.

## ✨ Features

- 🤖 AI-powered SRS generation
- ❓ AI clarification questions
- 📝 SRS editing
- 💾 Save projects and documents
- 🔄 SRS version history
- 💬 Comments and review
- 📄 Export to PDF
- 📃 Export to DOCX

## 🛠️ Tech Stack

### Frontend

- React
- TypeScript
- Tailwind CSS

### Backend

- Node.js
- Express
- TypeScript

### Database

- PostgreSQL
- Prisma

### AI

- OpenAI API

### Authentication

- JWT
- bcrypt

### Validation

- Zod

### Documents

- PDFKit
- docx

### Testing

- Postman
- Jest

### Version Control

- Git
- GitHub

## 🏗️ Project Structure

```text
srs-ai/
├── client/
│   └── React application
├── server/
│   └── Node.js application
├── prisma/
│   └── database schema
├── docs/
│   ├── API.md
│   └── DATABASE.md
├── .gitignore
├── README.md
└── package.json
