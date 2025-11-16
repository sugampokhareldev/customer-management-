import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

// ⭐ --- THIS IS THE CORRECT IMPORT --- ⭐
import { GoogleGenerativeAI } from '@google/generative-ai';

// NEW: Import pdfkit
import PDFDocument from 'pdfkit';


// --- Setup for ES Modules __dirname ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================================
// --- DATABASE (MONGODB) SETUP ---
// ==========================================================

// Connect to MongoDB
async function connectToDb() {
  if (!process.env.MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in .env file.");
    process.exit(1);
  }
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('🚀 Connected to MongoDB successfully!');
  } catch (error) {
    console.error("FATAL ERROR: Could not connect to MongoDB.", error);
    process.exit(1);  
  }
}

// Define the "Schema"
const customerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: String,
  address: String,
  price: Number,
  priceType: { type: String, default: 'Fixed' },
  recurring: String,
  paymentStatus: String,
  workStatus: String,
  nextVisit: { type: String, required: true },
  visitTime: String,
  lastPayment: String,
  notes: String,
});

// Create a "Model"
const Customer = mongoose.model('Customer', customerSchema);


// --- Express App Setup ---
const app = express();

// Simple rate limiter
const emailRateLimit = new Map();

// ==========================================================
// --- RENDER PROXY & CORS FIX ---
// ==========================================================
app.set('trust proxy', 1);  
app.use(cors({
  origin: 'https://customer-management-sm4h.onrender.com',  
  credentials: true  
}));
// ==========================================================

// Add payload limits for security
app.use(express.json({ limit: '1mb' }));  
app.use(express.urlencoded({ extended: true, limit: '1mb' }));  

// Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',  
    httpOnly: true,  
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',  
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// START: NEWLY ADDED SECURITY HEADERS
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// END: NEWLY ADDED SECURITY HEADERS

// Serve static files
app.use(express.static(__dirname));  


// --- Nodemailer Setup ---
let transporter;
async function setupEmail() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const host = process.env.EMAIL_HOST;
  const port = process.env.EMAIL_PORT;
  if (!user || !pass || !host || !port) {
    console.warn("WARNING: Email credentials not found in .env file. Email sending will fail.");
  } else {
    console.log("--- 📧 Nodemailer ---");
    console.log(`Using Email Host: ${host} Port: ${port}`);
    console.log("--------------------");
    transporter = nodemailer.createTransport({
      host: host,  
      port: port,  
      secure: port == 465,  
      auth: { user, pass },
    });
  }
}

// --- Gemini AI Setup ---
let genAI;
let aiModel;
async function setupAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("WARNING: GEMINI_API_KEY not found in .env file. AI features will fail.");
  } else {
    try {
      genAI = new GoogleGenerativeAI(apiKey);
      // FIX: Changed the model name from gemini-1.5-flash (which returned 404) to gemini-2.5-flash
      aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      console.log('🤖 Google Gemini AI model initialized successfully!');
    } catch (error) {
      console.error("FATAL ERROR: Could not initialize Gemini AI.", error.message);
    }
  }
}

// --- Helper function for local dates ---
function getLocalYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- PDF Generation Helper (Enhanced) ---
function generateCustomerPDF(res, customers, filterInfo) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  // Header
  doc.fillColor('#0056b3').fontSize(20).font('Helvetica-Bold')
     .text('Customer Management Report', { align: 'center' });
  
  doc.moveDown(0.5);
  doc.fillColor('#666666').fontSize(10)
     .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
  
  doc.fillColor('#333333').fontSize(9).font('Helvetica-Oblique')
     .text(filterInfo, { align: 'center' });
  
  doc.moveDown(1);

  // Summary
  doc.fillColor('#333333').fontSize(12).font('Helvetica-Bold')
     .text(`Total Customers: ${customers.length}`);
  
  const completed = customers.filter(c => c.workStatus === 'Completed').length;
  const pending = customers.filter(c => c.paymentStatus === 'Pending').length;
  const overdue = customers.filter(c => c.paymentStatus === 'Overdue').length;
  
  doc.fontSize(10).font('Helvetica')
     .text(`Completed: ${completed} | Pending Payment: ${pending} | Overdue: ${overdue}`);
  
  doc.moveDown(1);

  // Table Header
  const tableTop = doc.y;
  const col1 = 50;   // Name
  const col2 = 150;  // Email
  const col3 = 300;  // Next Visit
  const col4 = 380;  // Status
  const col5 = 450;  // Price

  doc.fillColor('#ffffff').rect(col1, tableTop, 500, 20).fill('#0056b3');
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
  doc.text('Name', col1 + 5, tableTop + 5);
  doc.text('Email', col2, tableTop + 5);
  doc.text('Next Visit', col3, tableTop + 5);
  doc.text('Status', col4, tableTop + 5);
  doc.text('Price', col5, tableTop + 5, { align: 'right' });

  let yPosition = tableTop + 25;
  doc.fillColor('#333333').font('Helvetica');

  // Table Rows
  customers.forEach((customer, index) => {
    if (yPosition > 700) {
      doc.addPage();
      yPosition = 50;
      
      // Redraw header
      doc.fillColor('#ffffff').rect(col1, yPosition, 500, 20).fill('#0056b3');
      doc.fillColor('#ffffff');
      doc.text('Name', col1 + 5, yPosition + 5);
      doc.text('Email', col2, yPosition + 5);
      doc.text('Next Visit', col3, yPosition + 5);
      doc.text('Status', col4, yPosition + 5);
      doc.text('Price', col5, yPosition + 5, { align: 'right' });
      yPosition += 25;
      doc.fillColor('#333333');
    }

    // Alternating row background
    if (index % 2 === 0) {
      doc.fillColor('#f8f9fa').rect(col1, yPosition - 5, 500, 20).fill();
      doc.fillColor('#333333');
    }

    // Customer data
    doc.fontSize(9);
    doc.text(customer.name || 'N/A', col1 + 5, yPosition, { width: 90, lineBreak: false });
    doc.text(customer.email || 'N/A', col2, yPosition, { width: 140, lineBreak: false });
    doc.text(customer.nextVisit || 'N/A', col3, yPosition, { width: 70, lineBreak: false });
    
    const status = customer.workStatus || customer.paymentStatus || 'N/A';
    let statusColor = '#666666';
    if (status.toLowerCase() === 'completed' || status.toLowerCase() === 'paid') statusColor = '#10B981';
    if (status.toLowerCase() === 'pending') statusColor = '#F59E0B';
    if (status.toLowerCase() === 'overdue') statusColor = '#EF4444';
    
    doc.fillColor(statusColor).text(status, col4, yPosition, { width: 60, lineBreak: false });
    doc.fillColor('#333333');
    
    doc.text(
      customer.price ? `€${customer.price.toFixed(2)}` : 'N/A',
      col5, yPosition, { width: 100, align: 'right', lineBreak: false }
    );

    yPosition += 20;
  });

  // Footer
  const finalY = Math.min(yPosition + 20, 750);
  doc.fillColor('#666666').fontSize(8)
     .text(`Exported ${customers.length} customers | AJK Cleaners CRM`, 50, finalY, { align: 'center' });

  doc.end();
}



// ==========================================================
// --- ADMIN NOTIFICATION SERVICE ---
// ==========================================================
async function checkUpcomingVisitsAndNotifyAdmins() {
  console.log('Checking for upcoming visits to notify admins...');
  const adminEmails = process.env.ADMIN_RECIENT_EMAILS;
  if (!adminEmails) {
    console.log('ADMIN_RECIENT_EMAILS not set. Skipping admin notifications.');
    return;
  }
  
  const verifiedSender = process.env.VERIFIED_SENDER_EMAIL;
  if (!verifiedSender) {
    console.log('VERIFIED_SENDER_EMAIL not set. Skipping admin notifications.');
    return;
  }

  if (!transporter) {
    console.warn('Email transporter is not configured. Skipping admin notifications.');
    return;
  }

  try {
    const today = new Date();

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = getLocalYYYYMMDD(tomorrow);

    const dayAfterTomorrow = new Date(today);
    dayAfterTomorrow.setDate(today.getDate() + 2);
    const dayAfterTomorrowStr = getLocalYYYYMMDD(dayAfterTomorrow);

    console.log(`Notification check: Searching for visits on ${tomorrowStr} and ${dayAfterTomorrowStr}.`);

    const customers = await Customer.find({
      nextVisit: { $in: [tomorrowStr, dayAfterTomorrowStr] },
      workStatus: 'Pending'
    }).sort({ nextVisit: 'asc' });

    if (customers.length === 0) {
      console.log('No upcoming pending visits found.');
      return;
    }

    console.log(`Found ${customers.length} upcoming visits. Preparing notification...`);

    const emailBody = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #0056b3;">Upcoming Visit Reminders</h2>
        <p>Hello Admin,</p>
        <p>Here is a list of upcoming customer visits for the next 48 hours:</p>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f4f4f4;">
              <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Customer</th>
              <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Visit Date & Time</th>
              <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Timeframe</th>
            </tr>
          </thead>
          <tbody>
            ${customers.map(customer => `
              <tr>
                <td style="padding: 10px; border: 1px solid #ddd;"><strong>${customer.name}</strong><br><small>${customer.email || 'No email'}</small></td>
                <td style="padding: 10px; border: 1px solid #ddd;">${customer.nextVisit} ${customer.visitTime ? `at ${customer.visitTime}` : ''}</td>
                <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: ${customer.nextVisit === tomorrowStr ? '#D97706' : '#0056b3'}">
                  ${customer.nextVisit === tomorrowStr ? 'Tomorrow (1 day)' : 'In 2 days'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <p style="margin-top: 20px; font-size: 0.9em; color: #777;">
          This is an automated notification from the Customer Management System.
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: `"CRM Notifier" <${verifiedSender}>`, 
      to: adminEmails, 
      subject: `🔔 Admin Alert: ${customers.length} Upcoming Visit(s)`,
      html: emailBody,
    });

    console.log(`Successfully sent admin notification for ${customers.length} customers to: ${adminEmails}`);

  } catch (error) {
    console.error('Error in admin notification service:', error);
  }
}

// ==========================================================
// --- PWA ASSET ROUTES (Public) ---
// ==========================================================

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});
// The ENOENT errors show these icons are missing. The route is correct for serving a local `icons` directory.
app.get('/icons/:icon', (req, res) => {
  res.sendFile(path.join(__dirname, 'icons', req.params.icon));
});


// ==========================================================
// --- AUTHENTICATION ROUTES (Public) ---
// ==========================================================
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  if (!adminUser || !adminPass) {
    console.error("FATAL: ADMIN_USER or ADMIN_PASS not set in .env");
    return res.redirect('/login?error=1');
  }
  if (username?.toLowerCase() === adminUser.toLowerCase() && password === adminPass) {
    req.session.isLoggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.redirect('/');
    res.clearCookie('connect.sid');  
    res.redirect('/login');
  });
});

// START: IMPROVEMENT 7 (Health Check)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});
// END: IMPROVEMENT 7

// ==========================================================
// --- AUTHENTICATION MIDDLEWARE ---
// ==========================================================
const isLoggedInPage = (req, res, next) => {
  if (req.session.isLoggedIn) return next();
  res.redirect('/login');
};
const isLoggedInApi = (req, res, next) => {
  if (req.session.isLoggedIn) return next();
  res.status(401).json({ message: 'Unauthorized. Please log in.' });
};

// Sanitization Middleware
const sanitizeInput = (req, res, next) => {
    if (req.body) {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                // Trim and limit length to 1000 chars
                req.body[key] = req.body[key].trim().substring(0, 1000); 
            }
        });
    }
    next();
};

// START: IMPROVEMENT 4 (Mongo Sanitize)
const sanitizeMongoQuery = (req, res, next) => {
    // Prevent NoSQL injection in body
    if (req.body && typeof req.body === 'object') {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                // Remove MongoDB operators
                if (req.body[key].startsWith('$')) {
                    console.warn(`Potential NoSQL injection attempt: ${key}=${req.body[key]}`);
                    delete req.body[key];
                }
            }
        });
    }
    // Prevent NoSQL injection in query params
    if (req.query && typeof req.query === 'object') {
         Object.keys(req.query).forEach(key => {
            if (typeof req.query[key] === 'string') {
                if (req.query[key].startsWith('$')) {
                    console.warn(`Potential NoSQL injection attempt: ${key}=${req.query[key]}`);
                    delete req.query[key];
                }
            }
         });
    }
    next();
};
// END: IMPROVEMENT 4


// ==========================================================
// --- PROTECTED API ROUTES ---
// ==========================================================
const apiRouter = express.Router();

// GET /api/customers
apiRouter.get('/customers', async (req, res) => {
  try {
    const customers = await Customer.find();
    const today = getLocalYYYYMMDD(new Date()); 
    await Promise.all(customers.map(async (customer) => {
      let needsSave = false;
      if (customer.paymentStatus === 'Pending' && customer.nextVisit < today) {
        customer.paymentStatus = 'Overdue';
        needsSave = true;
      }
      if (customer.workStatus === 'Completed' && customer.paymentStatus === 'Paid' && customer.nextVisit <= today) {
        customer.workStatus = 'Pending';
        needsSave = true;
      }
      if (needsSave) {
        await customer.save();
      }
    }));
    res.json(customers.map(c => ({...c.toObject(), id: c._id })));
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ message: "Error fetching customers", error });
  }
});

// --- "Smart Agenda" API Route ---
apiRouter.get('/agenda-summary', async (req, res) => {
  if (!aiModel) {
    return res.status(500).json({ message: "AI service is not initialized." });
  }

  try {
    const today = getLocalYYYYMMDD(new Date());
    const customers = await Customer.find();

    const pendingJobs = customers
      .filter(c => c.workStatus === 'Pending' && c.nextVisit >= today)
      .map(c => ({ 
          name: c.name, 
          nextVisit: c.nextVisit, 
          visitTime: c.visitTime,
          notes: c.notes
      }))
      .sort((a, b) => a.nextVisit.localeCompare(b.nextVisit));  

    const jobList = pendingJobs.length > 0
      ? pendingJobs.map(j => `- ${j.name} on ${j.nextVisit}${j.visitTime ? ` at ${j.visitTime}` : ''}${j.notes ? ` (Note: ${j.notes})` : ''}`).join('\n')
      : "No pending jobs.";

    const prompt = `
      You are a friendly, professional business assistant for a cleaning service.
      Today's date is ${today}.
      Here is a list of upcoming pending jobs:
      ${jobList}

      Please write a very short, friendly, 1-2 sentence summary of the agenda.
      - If there are jobs today, mention the customer names (e.g., "You have jobs for [Name1] and [Name2] today.").
      - If there are jobs today with notes, briefly mention there are notes (e.g., "You have jobs for [Name1] (check notes) and [Name2] today.").
      - If there are no jobs today but jobs later this week, mention the next upcoming job (e.g., "Today is clear. Your next job is for [Name] on [Date].").
      - If there are no jobs at all, say so.
      - Be encouraging and concise.
    `;

    const result = await aiModel.generateContent(prompt);
    const response = result.response;
    const summary = response.text();

    res.json({ summary: summary });

  } catch (error) {
    console.error("Error generating AI summary:", error);
    if (error.response) {
        console.error("GEMINI API Error Details:", error.response);
    }
    res.status(500).json({ message: "Error generating agenda summary." });
  }
});

// POST /api/customers
apiRouter.post('/customers', async (req, res) => {
  try {
    const newCustomer = new Customer({
      ...req.body,
      priceType: req.body.priceType || 'Fixed'
    });
    await newCustomer.save();
    res.status(201).json({...newCustomer.toObject(), id: newCustomer._id });
  } catch (error) {
    console.error("Error creating customer:", error);
    res.status(400).json({ message: "Error creating customer", error });
  }
});

// PUT /api/customers/:id
apiRouter.put('/customers/:id', async (req, res) => {
  const id = req.params.id;  
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid customer ID' });
  }
  
  try {
    const updateData = { ...req.body };
    delete updateData.id;
    delete updateData._id;

    const updatedCustomer = await Customer.findByIdAndUpdate(
      id,  
      updateData,  
      { new: true, runValidators: true }  
    );
    if (!updatedCustomer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.json({...updatedCustomer.toObject(), id: updatedCustomer._id });
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(400).json({ message: "Error updating customer", error });
  }
});

// DELETE /api/customers/:id
apiRouter.delete('/customers/:id', async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid customer ID' });
  }

  try {
    const deletedCustomer = await Customer.findByIdAndDelete(id);
    if (!deletedCustomer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    res.status(204).send(); // Success, no content
  } catch (error) {
    console.error("Error deleting customer:", error);
    res.status(500).json({ message: "Error deleting customer", error });
  }
});

// POST /api/customers/:id/remind
apiRouter.post('/customers/:id/remind', async (req, res) => {
  if (!transporter) {
    return res.status(500).json({ message: "Email service is not configured." });
  }
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }
    
    // Rate Limiting Logic
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxEmails = 5;
    
    if (!emailRateLimit.has(id)) {
        emailRateLimit.set(id, []);
    }
    
    const requests = emailRateLimit.get(id);
    const recentRequests = requests.filter(time => now - time < windowMs);
    
    if (recentRequests.length >= maxEmails) {
        return res.status(429).json({ message: 'Too many reminder emails sent. Please try again later.' });
    }

    const { message: optionalMessage, language } = req.body;
    const customer = await Customer.findById(id);
    
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    if (!customer.email) {
      return res.status(400).json({ message: 'This customer has no email address on file.' });
    }

    // --- Helper Functions ---
    const formatDate = (dateString, lang = 'en-US') => {
      if (!dateString) return 'N/A';
      const date = new Date(dateString);
      const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
      return date.toLocaleDateString(lang, options);
    };
    const formatTime = (timeString) => {
        if (!timeString) return '';
        return ` at ${timeString}`
    }
    
    const formatCurrency = (value, priceType) => {
       if (value == null || isNaN(Number(value))) return 'N/A';
       const formattedPrice = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
       return priceType === 'Hourly' ? `${formattedPrice}/hr` : formattedPrice;
    };
    
    const formatStatus = (status, lang = 'en') => {
      if (!status) return 'N/A';
      let color = '#333';  
      let fontWeight = 'normal';
      let statusText = status;
      if (lang === 'de') {
          if (status.toLowerCase() === 'pending') statusText = 'Ausstehend';
          if (status.toLowerCase() === 'paid') statusText = 'Bezahlt';
          if (status.toLowerCase() === 'overdue') statusText = 'Überfällig';
      }
      switch (status.toLowerCase()) {
        case 'pending': color = '#D97706'; fontWeight = 'bold'; break;
        case 'overdue': color = '#D9534F'; fontWeight = 'bold'; break;
        case 'paid': color = '#10B981'; fontWeight = 'bold'; break;
      }
      return `<span style="color: ${color}; font-weight: ${fontWeight};">${statusText}</span>`;
    };
    
    const visitDateEN = formatDate(customer.nextVisit, 'en-US');
    const visitDateDE = formatDate(customer.nextVisit, 'de-DE');
    const visitTime = formatTime(customer.visitTime);
    const visitAddress = customer.address ? customer.address.replace(/\n/g, '<br>') : 'On file';
    const visitAddressDE = customer.address ? customer.address.replace(/\n/g, '<br>') : 'Gespeichert';
    const customerNotes = customer.notes ? customer.notes.replace(/\n/g, '<br>') : '';

    const serviceTypeEN = customer.recurring === 'None' ? 'One-Time Cleaning' : `${customer.recurring} Cleaning`;
    const serviceTypeDE = customer.recurring === 'None' ? 'Einmalige Reinigung' : `${customer.recurring.replace('Weekly', 'Wöchentliche').replace('Bi-weekly', 'Zweiwöchentliche').replace('Monthly', 'Monatliche')} Reinigung`;
    const servicePrice = formatCurrency(customer.price, customer.priceType);

    let emailSubject = '';
    let emailBody = '';
    
    const notesBlockEN = customerNotes ? `
        <li style="margin-top: 5px;"><strong>Notes on File:</strong><br><em style="color: #555;">${customerNotes}</em></li>
    ` : '';
    const notesBlockDE = customerNotes ? `
        <li style="margin-top: 5px;"><strong>Gespeicherte Notizen:</strong><br><em style="color: #555;">${customerNotes}</em></li>
    ` : '';


    if (language === 'de') {
        const paymentStatusDisplay = formatStatus(customer.paymentStatus, 'de');
        emailSubject = `Erinnerung: Ihr bevorstehender Reinigungstermin am ${visitDateDE}`;
        emailBody = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <p>Hallo ${customer.name},</p>
            <p>Dies ist eine freundliche Erinnerung an Ihren bevorstehenden Reinigungstermin am <strong>${visitDateDE}${visitTime}</strong>.</p>
            <h3 style="color: #0056b3; border-bottom: 1px solid #eee; padding-bottom: 5px;">Service-Details:</h3>
            <ul style="list-style-type: none; padding-left: 0;">
              <li><strong>Typ:</strong> ${serviceTypeDE}</li>
              <li><strong>Preis:</strong> ${servicePrice}</li>  
              <li><strong>Zahlungsstatus:</strong> ${paymentStatusDisplay}</li>
              <li><strong>Adresse:</strong><br>${visitAddressDE}</li>
              ${notesBlockDE}
            </ul>
            ${customer.recurring !== 'None' ? `<p>Vielen Dank, dass Sie Teil unseres ${customer.recurring.toLowerCase()} Serviceplans sind. Wir schätzen Ihr anhaltendes Vertrauen in AJK Cleaners und freuen uns darauf, Sie zu bedienen.</p>` : ''}
            ${optionalMessage ? `<div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; margin-top: 20px;"><p style="margin: 0;"><strong>Eine Anmerkung von unserem Team:</strong></p><p style="margin: 0; font-style: italic;">${optionalMessage.replace(/\n/g, '<br>')}</p></div>` : ''}
            <p style="margin-top: 20px;">Wenn Sie Fragen haben oder Ihren Termin verschieben möchten, kontaktieren Sie uns bitte unter <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a>, rufen Sie uns an unter +49 176 61852286 oder antworten Sie einfach auf diese E-Mail.</p>
            <p>Herzliche Grüße,<br>Das AJK Cleaners Team</p>
            <hr style="border: none; border-top: 1px solid #eee;"><p style="font-size: 0.9em; color: #777;">📧 <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a><br>🌐 <a href="https://www.ajkcleaners.de/">https://www.ajkcleaners.de/</a></p>
          </div>
        `;
    } else {
        const paymentStatusDisplay = formatStatus(customer.paymentStatus, 'en');
        emailSubject = `Reminder: Upcoming Cleaning Service on ${visitDateEN}`;
        emailBody = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <p>Hello ${customer.name},</p>
            <p>This is a friendly reminder of your upcoming cleaning appointment scheduled for <strong>${visitDateEN}${visitTime}</strong>.</p>
            <h3 style="color: #0056b3; border-bottom: 1px solid #eee; padding-bottom: 5px;">Service Details:</h3>
            <ul style="list-style-type: none; padding-left: 0;">
              <li><strong>Type:</strong> ${serviceTypeEN}</li>
              <li><strong>Price:</strong> ${servicePrice}</li>  
              <li><strong>Payment Status:</strong> ${paymentStatusDisplay}</li>
              <li><strong>Address:</strong><br>${visitAddress}</li>
              ${notesBlockEN}
            </ul>
            ${customer.recurring !== 'None' ? `<p>Thank you for being part of our ${customer.recurring.toLowerCase()} service plan. We truly appreciate your continued trust in AJK Cleaners and look forward to serving you.</p>` : ''}
            ${optionalMessage ? `<div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; margin-top: 20px;"><p style="margin: 0;"><strong>A note from our team:</strong></p><p style="margin: 0; font-style: italic;">${optionalMessage.replace(/\n/g, '<br>')}</p></div>` : ''}
            <p style="margin-top: 20px;">If you have any questions or would like to postpone your appointment, please contact us at <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a>, call us at +49 176 61852286, or simply reply to this email.</p>
            <p>Warm regards,<br>The AJK Cleaners Team</p>
            
            <hr style="border: none; border-top: 1px solid #eee;"><p style="font-size: 0.9em; color: #777;">📧 <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a><br>🌐 <a href="https://www.ajkcleaners.de/">https://www.ajkcleaners.de/</a></p>
          </div>
        `;
    }

    // --- SendMail Block ---
    try {
      const verifiedSender = process.env.VERIFIED_SENDER_EMAIL;
      if (!verifiedSender) {
         console.error("VERIFIED_SENDER_EMAIL is not set in .env file.");
         return res.status(500).json({ message: 'Email service is not configured correctly.' });
      }
      
      await transporter.sendMail({
        from: `"AJK Cleaners" <${verifiedSender}>`, 
        to: customer.email,
        subject: emailSubject,
        html: emailBody,
        replyTo: verifiedSender
      });
      
      // Update rate limit map on success
      recentRequests.push(now);
      emailRateLimit.set(id, recentRequests);
      
      const successMessage = language === 'de' ? 'E-Mail erfolgreich gesendet!' : 'Email sent successfully!';
      res.json({ message: successMessage });

    } catch (emailError) {
      console.error("Error sending email:", emailError);
      res.status(500).json({ message: 'Error sending email' });
    }

  } catch (routeError) {
    console.error("Error in /remind route:", routeError);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/customers/:id/complete
apiRouter.post('/customers/:id/complete', async (req, res) => {
  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: 'Invalid customer ID' });
  }
  try {
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    customer.workStatus = 'Completed';
    customer.paymentStatus = 'Pending';
    customer.lastPayment = null;  

    if (customer.recurring !== 'None') {
      const parts = customer.nextVisit.split('-').map(Number);
      const currentVisitDate = new Date(parts[0], parts[1] - 1, parts[2]);

      if (customer.recurring === 'Weekly') {
        currentVisitDate.setDate(currentVisitDate.getDate() + 7);
      } else if (customer.recurring === 'Bi-weekly') {
        currentVisitDate.setDate(currentVisitDate.getDate() + 14);
      } else if (customer.recurring === 'Monthly') {
        currentVisitDate.setMonth(currentVisitDate.getMonth() + 1);
      }
      customer.nextVisit = getLocalYYYYMMDD(currentVisitDate);
    }
    
    await customer.save();
    res.json({ message: 'Job completed and next visit scheduled!', customer: {...customer.toObject(), id: customer._id } });
} catch (error) {
    console.error("Error completing job:", error);
    res.status(500).json({ message: "Error completing job", error });
  }
});

// START: IMPROVEMENT 5 (Enhanced PDF Export)
apiRouter.post('/export/pdf', async (req, res) => {
    try {
        const { ids, filterInfo } = req.body;

        if (!Array.isArray(ids)) {
            return res.status(400).json({ message: 'Invalid request: "ids" must be an array.' });
        }
        
        // Validate ObjectIds to prevent crashes
        const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
        if (validIds.length === 0) {
            return res.status(400).json({ message: 'No valid customer IDs provided.' });
        }
        
        const customers = await Customer.find({
            '_id': { $in: validIds }
        });

        if (customers.length === 0) {
            return res.status(404).json({ message: 'No customers found for the provided IDs.' });
        }

        const info = filterInfo || `Report of ${customers.length} customers`;
        
        // Set filename in header
        res.setHeader('Content-Disposition', `attachment; filename="customers_${getLocalYYYYMMDD(new Date())}.pdf"`);
        generateCustomerPDF(res, customers, info);

    } catch (error) {
        console.error("Error generating PDF:", error);
        res.status(500).json({ message: 'Error generating PDF report.' });
    }
});
// END: IMPROVEMENT 5


// *** APPLY API PROTECTION ***
// Apply all security middleware
app.use('/api', sanitizeMongoQuery, sanitizeInput, isLoggedInApi, apiRouter);


// ==========================================================
// --- PROTECTED FRONTEND ROUTE ---
// ==========================================================
app.get('/', isLoggedInPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ==========================================================
// --- START SERVER ---
// ==========================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  await connectToDb(); // Connect to database
  await setupEmail(); // Set up email
  await setupAI(); // Set up AI
  console.log(`🚀 Server running on http://localhost:${PORT}`);

  // --- Start Admin Notification Service ---
  checkUpcomingVisitsAndNotifyAdmins();
  
  setInterval(checkUpcomingVisitsAndNotifyAdmins, 1000 * 60 * 60 * 24);  
});