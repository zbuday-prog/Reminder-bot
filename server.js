const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

dotenv.config();

const app = express();

// Parse URL-encoded bodies (this is what Slack sends for interactive events)
app.use(bodyParser.urlencoded({ extended: true }));
// Also parse JSON
app.use(express.json());

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const TRACKING_SHEET_ID = process.env.TRACKING_SHEET_ID;
const ZOLTAN_USER_ID = process.env.ZOLTAN_USER_ID;
const PORT = process.env.PORT || 3000;

// Parse service account credentials from environment variable
let serviceAccountCredentials;
try {
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentialsJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON environment variable not set');
  }
  serviceAccountCredentials = JSON.parse(credentialsJson);
  console.log('Service account credentials loaded successfully');
} catch (error) {
  console.error('Error parsing service account credentials:', error);
  process.exit(1);
}

const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    credentials: serviceAccountCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  })
});

// Column headers mapped to their deadline columns and group labels
// Groups: AR (All Routes), ABP, ABR
const COLUMN_MAP = [
  { initialsCol: 'All Routes Group A', deadlineCol: 'AR A Status', group: 'AR' },
  { initialsCol: 'All Routes Group B', deadlineCol: 'AR B Status', group: 'AR' },
  { initialsCol: 'All Routes Review',  deadlineCol: 'AR Rev Status', group: 'AR' },
  { initialsCol: 'ABP A Home Off',     deadlineCol: 'ABP HA Status', group: 'ABP' },
  { initialsCol: 'ABP A Away Off',     deadlineCol: 'ABP AA Status', group: 'ABP' },
  { initialsCol: 'ABR A Home Off',     deadlineCol: 'ABR HA Status', group: 'ABR' },
  { initialsCol: 'ABR A Away Off',     deadlineCol: 'ABR AA Status', group: 'ABR' }
];

// Determine which sheet to use based on current date.
// Sheet weeks: os7 = May 6-12, os8 = May 13-19, os9 = May 20-26, etc.
// We switch to the new sheet on Wednesday each week, so that Monday
// assignments from the previous game week are still caught on Tuesday.
function getCurrentSheetName() {
  const BASE_SHEET = 8;
  const BASE_WEDNESDAY = new Date('2026-05-13'); // First Wednesday we switch to os8
  const now = new Date();
  const diffMs = now - BASE_WEDNESDAY;
  if (diffMs < 0) {
    console.log('Current sheet: os7');
    return 'os7'; // Before May 13, use os7
  }
  const diffWeeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  const sheetNum = BASE_SHEET + diffWeeks;
  console.log(`Current sheet: os${sheetNum}`);
  return 'os' + sheetNum;
}

// Cache for Slack users to avoid rate limiting
let slackUsersCache = null;
let slackUsersCacheTime = 0;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

async function getSlackUsersCache() {
  const now = Date.now();
  
  // Return cached users if still valid
  if (slackUsersCache && (now - slackUsersCacheTime) < CACHE_DURATION_MS) {
    return slackUsersCache;
  }
  
  // Fetch fresh user list (with pagination support)
  try {
    let allUsers = [];
    let cursor = '';
    
    do {
      const params = { limit: 200 };
      if (cursor) params.cursor = cursor;
      
      const response = await axios.post(
        'https://slack.com/api/users.list',
        params,
        { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
      );
      
      if (!response.data.ok) {
        console.error('Slack users.list error:', response.data.error);
        break;
      }
      
      allUsers = allUsers.concat(response.data.members || []);
      cursor = response.data.response_metadata?.next_cursor || '';
      
      // Wait 2 seconds between pagination calls to avoid rate limiting
      if (cursor) await new Promise(resolve => setTimeout(resolve, 2000));
      
    } while (cursor);
    
    slackUsersCache = allUsers;
    slackUsersCacheTime = now;
    console.log(`Fetched ${allUsers.length} Slack users (cached for 1 hour)`);
    
    return slackUsersCache;
  } catch (error) {
    console.error('Error fetching Slack users:', error.message);
    return slackUsersCache || [];
  }
}

const INITIALS_TO_NAME = {
  'AAB': 'Aaron Bloch',
  'ALH': 'Alex Hellwig',
  'AI':  'Andrew Ites',
  'BS':  'Ben Stockwell',
  'BM':  'Billy Moy',
  'BMO': 'Brady Morrison',
  'BGE': 'Brett Geerling',
  'BV':  'Bryson Vesnaver',
  'CGA': 'Cameron Gale',
  'CMI': 'Cody Milardo',
  'CRE': 'Conor Redmond',
  'DF':  'Dave Fiorella',
  'DAH': 'David Holden',
  'EA':  'Ezekiel Ayers',
  'GME': 'Garrett Mehal',
  'JGU': 'Jake Gudoian',
  'JMN': 'Jeff McCann',
  'JWY': 'Jim Wyman',
  'JK':  'John Kosko',
  'JCA': 'Jordan Casper',
  'JP':  'Jordan Plocher',
  'JL':  'Josh Liskiewitz',
  'JUW': 'Julien Wilson',
  'KC':  'Kevin Connaghan',
  'KE':  'Khaled Elsayed',
  'LGR': 'Lauren Gray',
  'LSH': 'Logan Schocknesse',
  'LPA': 'Luke Paldino',
  'MBA': 'Mark Baker',
  'MAC': 'Martyn Carlisle',
  'MC':  'Matt Claassen',
  'MT':  'Matthew Tichenor',
  'MRO': 'Matthew Ross',
  'MLP': 'Michael Preville',
  'MM':  'Michael Mountford',
  'NLO': 'Nathan Lowes',
  'NAK': 'Nick Akridge',
  'RJO': 'Ronald Jones',
  'RCO': 'Ryan Cooley',
  'RMS': 'Ryan Smith',
  'SMC': 'Sam McGaw',
  'SIC': 'Simon Chester',
  'TCA': 'Taylor Cassady',
  'TB':  'Tim Beckman',
  'TL':  'Trevor Lynch',
  'WDL': 'Winston Dimel',
  'ZB':  'Zoltan Buday'
};

async function getSlackUserByInitials(initials) {
  try {
    const fullName = INITIALS_TO_NAME[initials.toUpperCase()];
    if (!fullName) {
      console.log(`No name mapping for: ${initials}`);
      return null;
    }

    // Use cached user list
    const users = await getSlackUsersCache();
    const searchLower = fullName.toLowerCase();
    const searchParts = searchLower.split(' ');
    
    for (const user of users) {
      const profile = user.profile || {};
      const realName = (profile.real_name || '').trim().toLowerCase();
      const displayName = (profile.display_name || '').trim().toLowerCase();
      
      // Try exact match first
      if (realName === searchLower || displayName === searchLower) {
        return user.id;
      }
      
      // Try partial match (e.g., "Matt" matches "Matthew")
      for (const part of searchParts) {
        if (part.length > 2 && (realName.includes(part) || displayName.includes(part))) {
          return user.id;
        }
      }
    }

    console.log(`❌ ${initials} (${fullName}) not found in Slack`);
    return null;
  } catch (error) {
    console.error('Error getting Slack user:', error.message);
    return null;
  }
}


async function readScheduleSheet() {
  try {
    const sheetName = getCurrentSheetName();
    console.log(`Reading sheet: ${sheetName}`);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:BZ`
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error reading Google Sheet:', error);
    return [];
  }
}

function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

// Get the start date (Wednesday) of the current sheet's week
function getSheetWeekStartDate() {
  const BASE_WEDNESDAY = new Date('2026-05-13'); // May 13 is Wednesday, start of os8
  const now = new Date();
  const diffMs = now - BASE_WEDNESDAY;
  
  let weeksOffset = 0;
  if (diffMs >= 0) {
    weeksOffset = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
  } else {
    weeksOffset = -1; // os7 week
  }
  
  // os7 starts Wednesday May 6, os8 starts Wednesday May 13, os9 starts Wednesday May 20, etc.
  const weekStartMs = BASE_WEDNESDAY.getTime() + (weeksOffset * 7 * 24 * 60 * 60 * 1000);
  return new Date(weekStartMs);
}

// Convert day name + time string to a date
// e.g., "SAT 17:00" in os8 week (May 13-19 Wed-Tue) → May 16 at 5pm
function parseDayString(dayString, weekStartDate) {
  if (!dayString || typeof dayString !== 'string') return null;
  
  const dayMap = { 'WED': 0, 'THU': 1, 'FRI': 2, 'SAT': 3, 'SUN': 4, 'MON': 5, 'TUE': 6 };
  const match = dayString.trim().match(/^(WED|THU|FRI|SAT|SUN|MON|TUE)\s+(\d{1,2}):(\d{2})$/i);
  
  if (!match) return null;
  
  const dayName = match[1].toUpperCase();
  const dayOffset = dayMap[dayName];
  
  if (dayOffset === undefined) return null;
  
  // Create a date for that day in the current week (week starts Wednesday)
  const resultDate = new Date(weekStartDate);
  resultDate.setDate(resultDate.getDate() + dayOffset);
  resultDate.setHours(parseInt(match[2]), parseInt(match[3]), 0, 0);
  
  return resultDate;
}

async function findAssignmentsForToday() {
  const data = await readScheduleSheet();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // assignments[initials] = { AR: count, ABP: count, ABR: count }
  const assignments = {};

  const colIndexMap = {};
  if (data[0]) {
    data[0].forEach((col, idx) => {
      colIndexMap[col.trim()] = idx;
    });
    console.log('Found columns:', Object.keys(colIndexMap).slice(0, 50)); // Log first 50 column names
  }

  // Get the week start date to parse day names correctly
  const weekStartDate = getSheetWeekStartDate();
  console.log(`Sheet week starts: ${weekStartDate.toDateString()}, looking for assignments on ${today.toDateString()}`);

  for (const config of COLUMN_MAP) {
    const initialsColIdx = colIndexMap[config.initialsCol];
    const deadlineColIdx = colIndexMap[config.deadlineCol];

    if (initialsColIdx === undefined || deadlineColIdx === undefined) {
      console.log(`Warning: Could not find columns: '${config.initialsCol}' or '${config.deadlineCol}'`);
      continue;
    }

    for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
      const initials = (data[rowIdx][initialsColIdx] || '').trim();
      const deadlineStr = (data[rowIdx][deadlineColIdx] || '').trim();

      if (initials && deadlineStr) {
        // Parse day name + time (e.g., "SAT 17:00") into an actual date
        const deadline = parseDayString(deadlineStr, weekStartDate);
        if (deadline && isSameDay(deadline, today)) {
          if (!assignments[initials]) {
            assignments[initials] = { AR: 0, ABP: 0, ABR: 0 };
          }
          assignments[initials][config.group]++;
          console.log(`Found assignment: ${initials} on ${deadlineStr} (${deadline.toDateString()})`);
        }
      }
    }
  }

  return assignments;
}

async function sendSlackReminder(userId, initials, groups) {
  try {
    // Build a human-readable breakdown of assignments
    const parts = [];
    if (groups.AR  > 0) parts.push(`${groups.AR} AR assignment${groups.AR  !== 1 ? 's' : ''}`);
    if (groups.ABP > 0) parts.push(`${groups.ABP} ABP assignment${groups.ABP !== 1 ? 's' : ''}`);
    if (groups.ABR > 0) parts.push(`${groups.ABR} ABR assignment${groups.ABR !== 1 ? 's' : ''}`);

    const total = (groups.AR || 0) + (groups.ABP || 0) + (groups.ABR || 0);
    const breakdown = parts.join(' and ');
    const groupKeys = Object.keys(groups).filter(k => groups[k] > 0).join('-');
    const date = new Date().toISOString().split('T')[0];

    const messageText = `Hey, just a gentle reminder that you have ${breakdown} today. Are you OK to do that by the deadline? 👀`;

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: messageText }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Got it' },
            action_id: `acknowledge_${initials}_${groupKeys}_${date}`,
            value: initials,
            style: 'primary'
          }
        ]
      }
    ];

    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: userId, blocks },
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );

    if (response.data.ok) {
      console.log(`Message sent to ${initials}: ${breakdown}`);
      return response.data.ts;
    } else {
      console.error(`Error sending message to ${initials}:`, response.data.error);
      return null;
    }
  } catch (error) {
    console.error(`Error sending Slack message to ${userId}:`, error);
    return null;
  }
}

async function logAcknowledgment(initials, timestamp, team) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKING_SHEET_ID,
      range: 'Acknowledgments!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[today, initials, team, 'Acknowledged', new Date().toISOString(), 'Button click']]
      }
    });
    
    console.log(`Logged acknowledgment for ${initials} - ${team}`);
  } catch (error) {
    console.error('Error logging to tracking sheet:', error);
  }
}

async function notifyZoltan(message) {
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: ZOLTAN_USER_ID,
        text: message
      },
      {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      }
    );
  } catch (error) {
    console.error('Error notifying Zoltan:', error);
  }
}

async function runReminderCheck() {
  console.log('Running daily reminder check...');
  
  // Pre-fetch Slack users once before processing assignments
  // If rate limited, wait 30 seconds and try once more
  let users = await getSlackUsersCache();
  if (!users || users.length === 0) {
    console.log('Slack users fetch failed, waiting 30 seconds before retry...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    users = await getSlackUsersCache();
  }
  
  if (!users || users.length === 0) {
    console.log('Could not fetch Slack users, aborting check');
    await notifyZoltan('⚠️ Could not fetch Slack users (rate limited). Please try again later.');
    return;
  }
  
  console.log(`Using ${users.length} Slack users for lookup`);
  
  const assignments = await findAssignmentsForToday();
  
  if (Object.keys(assignments).length === 0) {
    console.log('No assignments found for today');
    await notifyZoltan(`ℹ️ Daily reminder check ran but found no assignments for today.`);
    return;
  }
  
  const sentTo = [];
  for (const [initials, groups] of Object.entries(assignments)) {
    const userId = await getSlackUserByInitials(initials);

    if (userId) {
      await sendSlackReminder(userId, initials, groups);
      sentTo.push(`${initials} (${INITIALS_TO_NAME[initials]})`);
    } else {
      console.log(`Could not find Slack user for ${initials}`);
      await notifyZoltan(`⚠️ Could not find Slack user for initials: ${initials}`);
    }
  }
  
  const reminderSummary = sentTo.length > 0 
    ? `✅ Daily reminder check completed. Sent reminders to: ${sentTo.join(', ')}`
    : `ℹ️ Daily reminder check completed. No Slack users found for any assignments.`;
  await notifyZoltan(reminderSummary);
}

app.post('/slack/actions', (req, res) => {
  try {
    console.log('Slack request received');
    console.log('Body:', JSON.stringify(req.body));
    
    const body = req.body;

    // Handle URL verification challenge
    if (body && body.type === 'url_verification') {
      console.log('Sending challenge:', body.challenge);
      return res.status(200).json({ challenge: body.challenge });
    }

    // Handle button clicks
    if (body && body.payload) {
      const payload = typeof body.payload === 'string' ? JSON.parse(body.payload) : body.payload;
      if (payload.type === 'block_actions' && payload.actions && payload.actions.length > 0) {
        const action = payload.actions[0];
        if (action.action_id && action.action_id.startsWith('acknowledge_')) {
          const parts = action.action_id.split('_');
          const initials = parts[1];
          const team = parts[2];
          const date = parts[3];
          console.log(`Button clicked: ${initials} - ${team} - ${date}`);
          // Run async tasks without blocking response
          logAcknowledgment(initials, new Date().toISOString(), team).catch(console.error);
          notifyZoltan(`📌 ${initials} acknowledged their assignment reminder for ${date} (${team})`).catch(console.error);
        }
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /slack/actions:', err);
    return res.status(200).send('OK');
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

app.get('/run-check', async (req, res) => {
  console.log('Manual reminder check triggered (GET)');
  await runReminderCheck();
  res.status(200).json({ status: 'Check completed' });
});

app.post('/run-check', async (req, res) => {
  console.log('Manual reminder check triggered (POST)');
  await runReminderCheck();
  res.status(200).json({ status: 'Check completed' });
});

// Schedule for 9am ET daily
cron.schedule('0 9 * * *', runReminderCheck, {
  timezone: 'America/New_York'
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Reminder check scheduled for 9am ET daily');
});
