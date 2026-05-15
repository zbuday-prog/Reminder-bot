const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const TRACKING_SHEET_ID = process.env.TRACKING_SHEET_ID;
const ZOLTAN_USER_ID = process.env.ZOLTAN_USER_ID;
const PORT = process.env.PORT || 3000;

const sheets = google.sheets({
  version: 'v4',
  auth: GOOGLE_API_KEY
});

const COLUMN_MAP = {
  AS: { deadline: 'AT', team: 'Team 1' },
  BK: { deadline: 'BL', team: 'Team 2' },
  BM: { deadline: 'BN', team: 'Team 3' },
  BQ: { deadline: 'BR', team: 'Team 4' },
  BS: { deadline: 'BT', team: 'Team 5' }
};

async function getSlackUserByInitials(initials) {
  try {
    const response = await axios.post(
      'https://slack.com/api/users.list',
      {},
      {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      }
    );
    
    const users = response.data.members;
    for (const user of users) {
      const profile = user.profile || {};
      // Check display_name first, then real_name
      const displayName = profile.display_name || profile.real_name || '';
      if (displayName.toUpperCase().includes(initials.toUpperCase())) {
        return user.id;
      }
    }
    return null;
  } catch (error) {
    console.error('Error fetching Slack users:', error);
    return null;
  }
}

async function readScheduleSheet() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'os7!A:BT'
    });
    
    return response.data.values || [];
  } catch (error) {
    console.error('Error reading Google Sheet:', error);
    return [];
  }
}

function getDateFromCell(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

async function findAssignmentsForToday() {
  const data = await readScheduleSheet();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const assignments = {};
  
  const colIndexMap = {};
  if (data[0]) {
    data[0].forEach((col, idx) => {
      colIndexMap[col] = idx;
    });
  }
  
  for (const [initialsCol, config] of Object.entries(COLUMN_MAP)) {
    const initialsColIdx = colIndexMap[initialsCol];
    const deadlineColIdx = colIndexMap[config.deadline];
    
    if (initialsColIdx === undefined || deadlineColIdx === undefined) {
      console.log(`Warning: Could not find columns for ${initialsCol}`);
      continue;
    }
    
    for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
      const initials = data[rowIdx][initialsColIdx];
      const deadlineStr = data[rowIdx][deadlineColIdx];
      
      if (initials && deadlineStr) {
        const deadline = getDateFromCell(deadlineStr);
        if (deadline && isSameDay(deadline, today)) {
          if (!assignments[initials]) {
            assignments[initials] = [];
          }
          assignments[initials].push({
            team: config.team,
            deadline: deadlineStr,
            row: rowIdx
          });
        }
      }
    }
  }
  
  return assignments;
}

async function sendSlackReminder(userId, initials, count, team) {
  try {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hey, just a gentle reminder that you have ${count} assignment${count !== 1 ? 's' : ''} today. Are you OK to do that by the deadline? 👀`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Got it'
            },
            action_id: `acknowledge_${initials}_${team}_${new Date().toISOString().split('T')[0]}`,
            value: `${initials}`,
            style: 'primary'
          }
        ]
      }
    ];
    
    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: userId,
        blocks: blocks
      },
      {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      }
    );
    
    if (response.data.ok) {
      console.log(`Message sent to ${initials} for ${team}`);
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
  
  const assignments = await findAssignmentsForToday();
  
  if (Object.keys(assignments).length === 0) {
    console.log('No assignments found for today');
    await notifyZoltan(`ℹ️ Daily reminder check ran but found no assignments for today.`);
    return;
  }
  
  for (const [initials, tasks] of Object.entries(assignments)) {
    const userId = await getSlackUserByInitials(initials);
    
    if (userId) {
      const teamList = tasks.map(t => t.team).join(', ');
      await sendSlackReminder(userId, initials, tasks.length, teamList);
    } else {
      console.log(`Could not find Slack user for ${initials}`);
      await notifyZoltan(`⚠️ Could not find Slack user for initials: ${initials}`);
    }
  }
  
  await notifyZoltan(`✅ Daily reminder check completed. Sent reminders to ${Object.keys(assignments).length} person/people.`);
}

app.post('/slack/actions', async (req, res) => {
  const body = req.body;
  
  // Handle Slack's URL verification challenge
  if (body.type === 'url_verification') {
    res.status(200).send(body.challenge);
    return;
  }
  
  // Handle button clicks
  if (body.type === 'block_actions' || (body.payload && typeof body.payload === 'string')) {
    let payload;
    
    if (body.payload && typeof body.payload === 'string') {
      payload = JSON.parse(body.payload);
    } else {
      payload = body;
    }
    
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      
      if (action.action_id.startsWith('acknowledge_')) {
        const parts = action.action_id.split('_');
        const initials = parts[1];
        const team = parts[2];
        const date = parts[3];
        
        await logAcknowledgment(initials, new Date().toISOString(), team);
        
        await notifyZoltan(`📌 ${initials} acknowledged their assignment reminder for ${date} (${team})`);
      }
    }
  }
  
  res.status(200).send('');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

app.post('/run-check', async (req, res) => {
  console.log('Manual reminder check triggered');
  await runReminderCheck();
  res.status(200).json({ status: 'Check completed' });
});

// Schedule for 9am ET daily
cron.schedule('0 9 * * *', runReminderCheck, {
  timezone: 'America/New_York'
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Reminder check scheduled for 9am ET daily');
});
