# Wkil Backend

A comprehensive social media management platform backend that enables users to create, schedule, and manage Facebook content with AI-powered content generation capabilities.

## 🎯 Project Overview

Wkil is a full-featured backend API for managing social media content, specifically designed for Facebook page management. The platform provides:

- **AI-Powered Content Generation**: Leverages Google Gemini and Vertex AI to generate engaging social media posts with customizable tone, length, and context
- **Facebook Integration**: Complete OAuth integration for Facebook pages with support for posting, scheduling, comment management, and analytics
- **User Management**: Hierarchical role-based access control (Super Admin, Admin, Manager, User) with user assignment and management capabilities
- **Lead Management**: Capture and manage leads from various sources
- **Analytics & Tracking**: Comprehensive analytics for user activities, post performance, and engagement metrics
- **Image Management**: Cloudinary integration for image uploads and AI-generated image support
- **Security**: JWT-based authentication, rate limiting, request sanitization, and security headers

## 🛠 Tech Stack

### Core Technologies
- **Runtime**: Node.js 20.18.0
- **Framework**: Express.js 5.1.0
- **Language**: TypeScript 5.9.2
- **Database**: PostgreSQL
- **ORM**: Prisma 6.16.2

### AI & Cloud Services
- **Google Gemini API**: Content generation using Gemini 2.5 Flash model
- **Google Vertex AI**: Advanced AI capabilities for image generation
- **Cloudinary**: Image upload, storage, and management

### Authentication & Security
- **JWT**: JSON Web Tokens for authentication (access & refresh tokens)
- **bcrypt**: Password hashing
- **Helmet**: Security headers
- **express-rate-limit**: Rate limiting
- **express-validator**: Input validation and sanitization

### Additional Libraries
- **Axios**: HTTP client for external API calls
- **Multer**: File upload handling
- **Cookie Parser**: Cookie management
- **CORS**: Cross-origin resource sharing

### Development Tools
- **Nodemon**: Development server with hot reload
- **ts-node**: TypeScript execution
- **TypeScript**: Type-safe development

### Deployment
- **Docker**: Containerization
- **Fly.io**: Cloud deployment platform

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v20.18.0 or higher)
- **npm** or **yarn**
- **PostgreSQL** (v12 or higher)
- **Docker** (optional, for containerized deployment)
- **Google Cloud Account** (for Vertex AI and Gemini API)
- **Cloudinary Account** (for image management)
- **Facebook Developer Account** (for Facebook API integration)

## 🔧 Environment Variables

Create a `.env` file in the root directory with the following variables:

### Database
```env
DATABASE_URL="postgresql://username:password@localhost:5432/wkil?schema=public"
```

### Server Configuration
```env
PORT=8080
NODE_ENV=development
```

### Authentication
```env
JWT_SECRET=your-super-secret-jwt-key-here
JWT_REFRESH_SECRET=your-refresh-token-secret-here
```

### Google Cloud / AI Services
```env
# Gemini API (for content generation)
GEMINI_API_KEY=your-gemini-api-key

# Vertex AI (for advanced AI features)
GOOGLE_CLOUD_PROJECT_ID=your-google-cloud-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=./google-cloud-key.json
```

### Cloudinary (Image Management)
```env
CLOUDINARY_CLOUD_NAME=your-cloudinary-cloud-name
CLOUDINARY_API_KEY=your-cloudinary-api-key
CLOUDINARY_API_SECRET=your-cloudinary-api-secret
```

### Facebook API
```env
FB_APP_ID=your-facebook-app-id
FB_APP_SECRET=your-facebook-app-secret
FB_API_URL=https://graph.facebook.com/v19.0
```

### Security (Optional)
```env
ADMIN_IP_WHITELIST=127.0.0.1,::1
```

> **Note**: The `google-cloud-key.json` file should be placed in the root directory and contains your Google Cloud service account credentials. This file is gitignored for security reasons.

## 🚀 Local Development Setup

### 1. Clone the Repository
```bash
git clone <repository-url>
cd back-end
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Set Up Environment Variables
Create a `.env` file in the root directory and add all required environment variables as listed above.

### 4. Set Up Database

#### Option A: Using Local PostgreSQL
1. Create a PostgreSQL database:
```bash
createdb wkil
```

2. Update `DATABASE_URL` in your `.env` file with your database credentials.

#### Option B: Using Docker PostgreSQL
```bash
docker run --name wkil-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=wkil -p 5432:5432 -d postgres
```

### 5. Run Database Migrations
```bash
# Generate Prisma Client
npm run prisma:generate

# Run migrations
npm run prisma:migrate
```

### 6. Start Development Server
```bash
npm run dev
```

The server will start on `http://localhost:8080` (or the port specified in your `.env` file).

### 7. Verify Installation
Check the health endpoint:
```bash
curl http://localhost:8080/health
```

You should receive a JSON response with server status, uptime, and system information.

## 📁 Project Structure

```
back-end/
├── src/                    # Source TypeScript files
│   ├── config/            # Configuration files
│   │   ├── cloudinary.ts  # Cloudinary setup
│   │   ├── gemini.ts      # Gemini AI setup
│   │   ├── prisma.ts      # Prisma client
│   │   ├── upload.ts      # File upload config
│   │   └── vertexai.ts    # Vertex AI setup
│   ├── controllers/       # Route controllers
│   │   ├── admin.controller.ts
│   │   ├── lead.controller.ts
│   │   ├── manager.controller.ts
│   │   └── user.controller.ts
│   ├── middlewares/       # Express middlewares
│   │   ├── auth.middleware.ts      # JWT authentication
│   │   ├── rateLimit.middleware.ts # Rate limiting
│   │   ├── roleValidation.middleware.ts # Role-based access
│   │   ├── security.middleware.ts  # Security headers
│   │   └── validation.middleware.ts # Input validation
│   ├── routes/            # API routes
│   │   ├── admin.routes.ts
│   │   ├── auth.routes.ts
│   │   ├── content.routes.ts
│   │   ├── facebook.routes.ts
│   │   ├── lead.routes.ts
│   │   ├── manager.routes.ts
│   │   └── user.routes.ts
│   ├── services/          # Business logic
│   │   ├── admin.service.ts
│   │   ├── auth.service.ts
│   │   ├── content.service.ts
│   │   ├── facebook.service.ts
│   │   ├── lead.service.ts
│   │   └── user.service.ts
│   ├── utils/             # Utility functions
│   ├── app.ts             # Express app configuration
│   └── server.ts          # Server entry point
├── prisma/                # Database schema and migrations
│   ├── migrations/        # Database migration files
│   └── schema.prisma      # Prisma schema definition
├── dist/                  # Compiled JavaScript (generated)
├── Dockerfile             # Docker configuration
├── fly.toml              # Fly.io deployment config
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
└── README.md             # This file
```

## 🔌 API Endpoints

### Authentication (`/api/v1/auth`)
- `POST /register` - Register a new user
- `POST /login` - User login
- `POST /refresh` - Refresh access token
- `POST /logout` - User logout
- `GET /me` - Get current user information

### Users (`/api/v1/users`)
- User management endpoints (varies by role)

### Content (`/api/v1/content`)
- `POST /generate-post` - Generate AI-powered post content
- `POST /upload-image` - Upload image to Cloudinary

### Facebook (`/api/v1/facebook`)
- `GET /login` - Initiate Facebook OAuth flow
- `GET /login/callback` - Handle Facebook OAuth callback
- `GET /pages` - Get user's Facebook pages
- `POST /post` - Create a post on Facebook page
- `POST /schedule` - Schedule a post
- `GET /comments/:postId` - Get post comments
- `POST /reply` - Reply to a comment
- `GET /accounts` - Get user's Facebook accounts
- `GET /analytics` - Get user analytics
- `POST /switch-device` - Switch device for account
- `DELETE /accounts/:id` - Deactivate Facebook account
- `GET /admin/analytics` - Admin analytics (admin only)

### Leads (`/api/v1/leads`)
- Lead management endpoints

### Admin (`/api/v1/admin`)
- Admin management endpoints

### Manager (`/api/v1/manager`)
- Manager-specific endpoints

### Health Check
- `GET /health` - Server health and system information

> **Note**: Most endpoints require authentication via JWT token in the Authorization header or cookies.

## 🗄️ Database Schema

The application uses the following main models:

- **Admin**: Admin user accounts
- **User**: Regular users with hierarchical roles
- **UserManagement**: Manager-user relationships
- **Lead**: Lead information
- **FacebookAccount**: Connected Facebook accounts
- **FacebookPage**: Facebook pages associated with accounts
- **FacebookActivity**: Activity logs for Facebook operations
- **UserAnalytics**: User analytics and metrics

See `prisma/schema.prisma` for complete schema definition.

## 🔐 Authentication & Authorization

### Authentication Flow
1. User registers/logs in via `/api/v1/auth/register` or `/api/v1/auth/login`
2. Server returns access token and refresh token
3. Access token is used for authenticated requests (expires in 15 minutes)
4. Refresh token is used to obtain new access tokens (expires in 7 days)

### Role Hierarchy
- **super_admin**: Full system access
- **admin**: Administrative access
- **manager**: Can manage assigned users
- **user**: Standard user access

### Protected Routes
Most routes require authentication via the `authenticateToken` middleware. Some routes have additional role-based restrictions.

## 🧪 Development Scripts

```bash
# Start development server with hot reload
npm run dev

# Build TypeScript to JavaScript
npm run build

# Start production server
npm start

# Generate Prisma Client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate
```

## 🐳 Docker Deployment

### Build Docker Image
```bash
docker build -t wkil-backend .
```

### Run Docker Container
```bash
docker run -p 8080:8080 --env-file .env wkil-backend
```

## 🚢 Production Deployment

The project includes configuration for Fly.io deployment. To deploy:

1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Launch app: `fly launch`
4. Set environment variables: `fly secrets set KEY=value`
5. Deploy: `fly deploy`

## 🔒 Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcrypt with salt rounds
- **Rate Limiting**: Prevents abuse and DDoS attacks
- **Input Validation**: express-validator for input sanitization
- **Security Headers**: Helmet.js for security headers
- **CORS**: Configurable cross-origin resource sharing
- **Request Size Limits**: Prevents large payload attacks
- **IP Whitelisting**: Optional admin IP restrictions

## 📝 API Rate Limits

- **General**: 100 requests per 15 minutes
- **Authentication**: 5 requests per 15 minutes
- **Content Generation**: 10 requests per 15 minutes
- **Facebook Operations**: 20 requests per 15 minutes

## 🐛 Troubleshooting

### Common Issues

1. **Database Connection Error**
   - Verify PostgreSQL is running
   - Check `DATABASE_URL` in `.env`
   - Ensure database exists

2. **Prisma Client Not Generated**
   - Run `npm run prisma:generate`

3. **Google Cloud Authentication Error**
   - Verify `GOOGLE_APPLICATION_CREDENTIALS` path
   - Ensure `google-cloud-key.json` exists and is valid
   - Check service account permissions

4. **Facebook OAuth Issues**
   - Verify `FB_APP_ID` and `FB_APP_SECRET`
   - Check redirect URIs in Facebook App settings
   - Ensure OAuth scopes are correct

5. **Port Already in Use**
   - Change `PORT` in `.env`
   - Or kill the process using the port

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Ensure all tests pass
4. Submit a pull request

## 📄 License

ISC

## 👥 Authors

@Hesham Mansour

---

For more information or support, please contact me.


