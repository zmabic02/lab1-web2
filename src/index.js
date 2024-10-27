require('dotenv').config();
const express = require('express');
const { auth, requiresAuth } = require('express-openid-connect');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'public'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const authConfig = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_SECRET,
  baseURL: process.env.AUTH0_BASE_URL,
  clientID: process.env.AUTH0_CLIENT_ID,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL
};

app.use(auth(authConfig));

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT
});

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM tickets');
    const totalTickets = result.rows[0].count;
    res.render('index', { totalTickets });
  } catch (err) {
    res.status(500).send('Error fetching total tickets: ' + err);
  }
});

app.get('/callback', (req, res) => {
  res.redirect('/');
});

app.get('/generate-ticket', (req, res) => {
  res.render('generate-ticket');
});

app.post('/generate', requiresAuth(), async (req, res) => {
  const { vatin, firstName, lastName } = req.body;

  const vatinRegex = /^\d{11}$/;
  const nameRegex = /^[A-Za-z]+$/;

  if (!vatinRegex.test(vatin)) {
    return res.status(400).send('OIB must have exactly 11 digits.');
  }
  if (!nameRegex.test(firstName) || !nameRegex.test(lastName)) {
    return res.status(400).send('First name and last name must be letters only');
  }

  try {
    const countResult = await pool.query('SELECT COUNT(*) FROM tickets WHERE vatin = $1', [vatin]);
    const ticketCount = parseInt(countResult.rows[0].count);

    if (ticketCount >= 3) {
      return res.status(400).send('Cannot generate more than 3 tickets for this OIB.');
    }

    const ticketId = uuidv4();
    const ticketLink = `${process.env.AUTH0_BASE_URL}/generate/${ticketId}`;
    await pool.query(
      'INSERT INTO tickets (ticketId, vatin, firstName, lastName, createdAt) VALUES ($1, $2, $3, $4, NOW())',
      [ticketId, vatin, firstName, lastName]
    );

    res.redirect(`/generate/${ticketId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating ticket: ' + err);
  }
});

app.get('/generate/:id', requiresAuth(), async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM tickets WHERE ticketId = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).send('Ticket not found.');
    }

    const ticketLink = `${process.env.AUTH0_BASE_URL}ticket/${id}`;
    const qrCode = await QRCode.toDataURL(ticketLink);

    res.render('ticket', { qrCode, ticketLink });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching ticket details: ' + err);
  }
});


app.get('/ticket/:id', requiresAuth(), async (req, res) => {
  const { id } = req.params;
  const userInfo = req.oidc.user;

  try {
    const result = await pool.query('SELECT * FROM tickets WHERE ticketId = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).send('Ticket not found.');
    }

    const ticket = result.rows[0];

    const formattedDate = new Date(ticket.createdat).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    res.render('ticket-details', {
      OIB: ticket.vatin,
      firstName: ticket.firstname,
      lastName: ticket.lastname,
      createdAt: formattedDate,
      user: userInfo.name
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching ticket details.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running');
});
