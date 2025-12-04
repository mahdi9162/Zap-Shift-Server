const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

// Firebase SDK
const admin = require('firebase-admin');
const serviceAccount = require('./zap-shift-46d2a-firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Tracking Function
const crypto = require('crypto');

function generateTrackingId() {
  const prefix = 'ZS';
  const date = new Date();

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const formattedDate = `${yyyy}${mm}${dd}`;

  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();

  return `${prefix}-${formattedDate}-${randomPart}`;
}

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  try {
    const idToken = token.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@quantumvault.xg6nrc4.mongodb.net/?appName=QuantumVault`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db('zap_shift_db');
    const userCollection = db.collection('users');
    const parcelCollection = db.collection('parcels');
    const paymentCollection = db.collection('payment');
    const riderCollection = db.collection('riders');
    const trackingCollection = db.collection('trackings');

    // ---------- helpers ----------
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    // Tracking log helper
    const logTracking = async (trackingId, status) => {
      if (!trackingId) return; // safety guard

      const log = {
        trackingId,
        status, // e.g. 'pending_pickup', 'driver_assigned'
        details: status.split('_').join(' '),
        createdAt: new Date(),
      };
      await trackingCollection.insertOne(log);
    };

    // ছোট হেল্পার – parcel থেকে trackingId নিয়ে আসবে
    const getParcelTrackingId = async (parcelId) => {
      const parcel = await parcelCollection.findOne({ _id: new ObjectId(parcelId) });
      return parcel?.trackingId;
    };

    // ---------- User APIs (unchanged) ----------
    app.get('/users', verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        query.$or = [{ display: { $regex: searchText, $options: 'i' } }, { email: { $regex: searchText, $options: 'i' } }];
      }

      const cursor = userCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/users/:email/role', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || 'user' });
    });

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: 'user exists' });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await userCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    // ---------- Parcel APIs ----------
    app.get('/parcels', async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/parcels/rider', async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus !== 'parcel_delivered') {
        query.deliveryStatus = { $nin: ['parcel_delivered'] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    // --------- CREATE PARCEL + FIRST TRACKING ----------
    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();

      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;

      //  parcel_created
      await logTracking(trackingId, 'parcel_created');

      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    // --------- ASSIGN RIDER + TRACK 'driver_assigned' ----------
    app.patch('/parcels/:id', async (req, res) => {
      const { riderId, riderName, riderEmail } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updatedDoc = {
        $set: {
          deliveryStatus: 'driver_assigned',
          riderId,
          riderName,
          riderEmail,
        },
      };
      const result = await parcelCollection.updateOne(query, updatedDoc);

      // update rider info
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: 'in_delivery',
        },
      };

      await riderCollection.updateOne(riderQuery, riderUpdatedDoc);

      // tracking log
      const trackingId = await getParcelTrackingId(id);
      await logTracking(trackingId, 'driver_assigned');

      res.send(result);
    });

    // --------- UPDATE DELIVERY STATUS + TRACK ----------
    app.patch('/parcels/:id/status', async (req, res) => {
      const { deliveryStatus, riderId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          deliveryStatus,
        },
      };

      if (deliveryStatus === 'parcel_delivered') {
        // update rider info
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdatedDoc = {
          $set: {
            workStatus: 'available',
          },
        };
        await riderCollection.updateOne(riderQuery, riderUpdatedDoc);
      }

      const result = await parcelCollection.updateOne(query, updatedDoc);

      const trackingId = await getParcelTrackingId(id);
      await logTracking(trackingId, deliveryStatus);

      res.send(result);
    });

    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    // ---------- Payment + Tracking ----------
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'USD',
              unit_amount: amount,
              product_data: {
                name: `Please pay for: ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: 'payment',
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      console.log(session);
      res.send({ url: session.url });
    });

    app.patch('/payment-success', async (req, res) => {
      const sessionId = req.query.session_id;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;
      const queryPayment = { transactionId };

      const paymentExist = await paymentCollection.findOne(queryPayment);

      if (paymentExist) {
        return res.send({
          message: 'already exist',
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      if (session.payment_status === 'paid') {
        const parcelId = session.metadata.parcelId;

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });
        const trackingId = parcel?.trackingId || generateTrackingId();

        const parcelQuery = { _id: new ObjectId(parcelId) };
        const update = {
          $set: {
            paymentStatus: 'paid',
            deliveryStatus: 'parcel_paid',
            trackingId,
          },
        };
        const result = await parcelCollection.updateOne(parcelQuery, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId,
        };

        const resultPayment = await paymentCollection.insertOne(payment);

        await logTracking(trackingId, 'pending_pickup');

        return res.send({
          success: true,
          modifyParcel: result,
          trackingId,
          transactionId: session.payment_intent,
          paymentInfo: resultPayment,
        });
      }

      return res.send({ success: false });
    });

    // ---------- Payment history ----------
    app.get('/payment', verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;
      }

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: 'Forbidden access' });
      }

      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // ---------- Rider APIs  ----------
    app.get('/riders', async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }

      if (district) {
        query.riderDistrict = district;
      }

      if (workStatus) {
        query.workStatus = workStatus;
      }

      const cursor = riderCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post('/riders', async (req, res) => {
      const rider = req.body;
      rider.status = 'pending';
      rider.createdAt = new Date();

      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });

    app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          status,
          workStatus: 'available',
        },
      };
      const result = await riderCollection.updateOne(query, updatedDoc);

      if (status === 'approved') {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: 'rider',
          },
        };
        await userCollection.updateOne(userQuery, updateUser);
      }
      res.send(result);
    });

    // ---------- Tracking APIs ----------
    app.get('/trackings/:trackingId/logs', async (req, res) => {
      const trackingId = req.params.trackingId;
      const query = { trackingId };
      const result = await trackingCollection.find(query).toArray();
      res.send(result);
    });

    await client.db('admin').command({ ping: 1 });
    console.log('Pinged your deployment. You successfully connected to MongoDB!');
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Zap is shifting shifting!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
