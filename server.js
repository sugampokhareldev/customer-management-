import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import cors from 'cors';
import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

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
  email: { type: String, required: true },
  price: Number,
  priceType: { type: String, default: 'Fixed' },
  recurring: String,
  paymentStatus: String,
  workStatus: String,
  nextVisit: { type: String, required: true },
  lastPayment: String,
});

// Create a "Model"
const Customer = mongoose.model('Customer', customerSchema);


// --- Express App Setup ---
const app = express();

// ==========================================================
// --- RENDER PROXY & CORS FIX ---
// ==========================================================
app.set('trust proxy', 1); 
app.use(cors({
  origin: 'https://customer-management-sm4h.onrender.com', 
  credentials: true 
}));
// ==========================================================

app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 

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
    console.error("FATAL ERROR: Email credentials not found in .env file.");
    process.exit(1);
  }
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


// ==========================================================
// --- PROTECTED API ROUTES (NOW USING MONGOOSE) ---
// ==========================================================

const apiRouter = express.Router();

// GET /api/customers
apiRouter.get('/customers', async (req, res) => {
  try {
    const customers = await Customer.find();
    
    const today = new Date().toISOString().split('T')[0];
    
    await Promise.all(customers.map(async (customer) => {
      let needsSave = false;

      // 1. Auto-Overdue Check
      if (customer.paymentStatus === 'Pending' && customer.nextVisit < today) {
        customer.paymentStatus = 'Overdue';
        needsSave = true;
      }

      // 2. Auto-Reset Check (for new jobs)
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

// ⭐ UPDATED: POST /api/customers/:id/remind (with Language Logic)
apiRouter.post('/customers/:id/remind', async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid customer ID' });
    }
    
    // Get language from the request body
    const { message: optionalMessage, language } = req.body;
    const customer = await Customer.findById(id);
    
    if (!customer) return res.status(404).json({ message: 'Customer not found' });

    // --- Helper Functions ---
    const formatDate = (dateString, lang = 'en-US') => {
      if (!dateString) return 'N/A';
      const date = new Date(dateString);
      // Use 'de-DE' for German dates
      const options = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
      return date.toLocaleDateString(lang, options);
    };
    
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

      // Translate status text
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
    
    // --- Create variables ---
    const visitDateEN = formatDate(customer.nextVisit, 'en-US');
    const visitDateDE = formatDate(customer.nextVisit, 'de-DE');
    const serviceTypeEN = customer.recurring === 'None' ? 'One-Time Cleaning' : `${customer.recurring} Cleaning`;
    const serviceTypeDE = customer.recurring === 'None' ? 'Einmalige Reinigung' : `${customer.recurring.replace('Weekly', 'Wöchentliche').replace('Bi-weekly', 'Zweiwöchentliche').replace('Monthly', 'Monatliche')} Reinigung`;
    const servicePrice = formatCurrency(customer.price, customer.priceType);

    // --- Select Language Template ---
    let emailSubject = '';
    let emailBody = '';

    if (language === 'de') {
        // --- GERMAN TEMPLATE ---
        const paymentStatusDisplay = formatStatus(customer.paymentStatus, 'de');
        emailSubject = `Erinnerung: Ihr bevorstehender Reinigungstermin am ${visitDateDE}`;
        emailBody = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <p>Hallo ${customer.name},</p>
            <p>Dies ist eine freundliche Erinnerung an Ihren bevorstehenden Reinigungstermin am <strong>${visitDateDE}</strong>.</p>
            
            <h3 style="color: #0056b3; border-bottom: 1px solid #eee; padding-bottom: 5px;">Service-Details:</h3>
            <ul style="list-style-type: none; padding-left: 0;">
              <li><strong>Typ:</strong> ${serviceTypeDE}</li>
              <li><strong>Preis:</strong> ${servicePrice}</li> 
              <li><strong>Zahlungsstatus:</strong> ${paymentStatusDisplay}</li>
            </ul>
            
            ${customer.recurring !== 'None' ? `<p>Vielen Dank, dass Sie Teil unseres ${customer.recurring.toLowerCase()} Serviceplans sind. Wir schätzen Ihr anhaltendes Vertrauen in AJK Cleaners und freuen uns darauf, Sie zu bedienen.</p>` : ''}
            
            ${optionalMessage ? `
              <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; margin-top: 20px;">
                <p style="margin: 0;"><strong>Eine Anmerkung von unserem Team:</strong></p>
                <p style="margin: 0; font-style: italic;">${optionalMessage.replace(/\n/g, '<br>')}</p>
              </div>` : ''}
            
            <p style="margin-top: 20px;">Wenn Sie Fragen haben oder Ihren Termin verschieben möchten, kontaktieren Sie uns bitte unter <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a>, rufen Sie uns an unter +49 176 61852286 oder antworten Sie einfach auf diese E-Mail.</p>
            
            <p>Herzliche Grüße,<br>Das AJK Cleaners Team</p>
            
            <hr style="border: none; border-top: 1px solid #eee;">
            <p style="font-size: 0.9em; color: #777;">
              📧 <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a><br>
              🌐 <a href="https://ajkcleaners.de/">https://ajkcleaners.de/</a>
            </p>
          </div>
        `;
    } else {
        // --- ENGLISH TEMPLATE (DEFAULT) ---
        const paymentStatusDisplay = formatStatus(customer.paymentStatus, 'en');
        emailSubject = `Reminder: Upcoming Cleaning Service on ${visitDateEN}`;
        emailBody = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <p>Hello ${customer.name},</p>
            <p>This is a friendly reminder of your upcoming cleaning appointment scheduled for <strong>${visitDateEN}</strong>.</p>
            
            <h3 style="color: #0056b3; border-bottom: 1px solid #eee; padding-bottom: 5px;">Service Details:</h3>
            <ul style="list-style-type: none; padding-left: 0;">
              <li><strong>Type:</strong> ${serviceTypeEN}</li>
              <li><strong>Price:</strong> ${servicePrice}</li> 
              <li><strong>Payment Status:</strong> ${paymentStatusDisplay}</li>
            </ul>
            
            ${customer.recurring !== 'None' ? `<p>Thank you for being part of our ${customer.recurring.toLowerCase()} service plan. We truly appreciate your continued trust in AJK Cleaners and look forward to serving you.</p>` : ''}
            
            ${optionalMessage ? `
              <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; margin-top: 20px;">
                <p style="margin: 0;"><strong>A note from our team:</strong></p>
                <p style="margin: 0; font-style: italic;">${optionalMessage.replace(/\n/g, '<br>')}</p>
              </div>` : ''}
            
            <p style="margin-top: 20px;">If you have any questions or would like to postpone your appointment, please contact us at <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a>, call us at +49 176 61852286, or simply reply to this email.</p>
            
            <p>Warm regards,<br>The AJK Cleaners Team</p>
            
            <hr style="border: none; border-top: 1px solid #eee;">
            <p style="font-size: 0.9em; color: #777;">
              📧 <a href="mailto:info@ajkcleaners.de">info@ajkcleaners.de</a><br>
              🌐 <a href="https://ajkcleaners.de/">https://ajkcleaners.de/</a>
            </p>
          </div>
        `;
    }

    // --- SendMail Block ---
    try {
      await transporter.sendMail({
        from: '"AJK Cleaners" <info@ajkcleaners.de>',
        to: customer.email,
        subject: emailSubject,
        html: emailBody,
        replyTo: 'info@ajkcleaners.de' 
      });
      
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

// "COMPLETE JOB" API ROUTE
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

    // 1. Set new statuses
    customer.workStatus = 'Completed';
    customer.paymentStatus = 'Pending';
    customer.lastPayment = null; 

    // 2. Calculate next visit date (based on today)
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0); 

    if (customer.recurring === 'Weekly') {
      today.setUTCDate(today.getUTCDate() + 7);
    } else if (customer.recurring === 'Bi-weekly') {
      today.setUTCDate(today.getUTCDate() + 14);
    } else if (customer.recurring === 'Monthly') {
      today.setUTCMonth(today.getUTCMonth() + 1);
    }

    if (customer.recurring !== 'None') {
      customer.nextVisit = today.toISOString().split('T')[0];
    }
    
    // 3. Save and send back
    await customer.save();
    res.json({ message: 'Job completed and next visit scheduled!', customer: {...customer.toObject(), id: customer._id } });

  } catch (error) {
    console.error("Error completing job:", error);
    res.status(500).json({ message: "Error completing job", error });
  }
});


// *** APPLY API PROTECTION ***
app.use('/api', isLoggedInApi, apiRouter);


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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});