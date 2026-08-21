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

// New staff added from 2026 PFF Schedule - Staff List CSV (expanded roster)
// Includes both FT and PT staff not already in INITIALS_TO_NAME above.
// Unlike the legacy map, emails here are the ACTUAL emails from the roster
// (not derived from a formula), since PT staff use personal (gmail/yahoo/etc.)
// addresses. When a Slack ID is already known from the roster, it's used directly
// to skip the email lookup entirely.
const NEW_STAFF = {
  "BD": { name: "Bill Douglas", email: "bdouglas@teamworks.com", slackId: null },
  "BOC": { name: "Barry O'Connell", email: "boconnell@teamworks.com", slackId: null },
  "JUH": { name: "Julia Hershey", email: null, slackId: null },
  "MCE": { name: "Mike Cetta", email: "mcetta@teamworks.com", slackId: null },
  "MCR": { name: "Morgan Cruce", email: "mcruce@teamworks.com", slackId: null },
  "DFp": { name: "Dave Fiorella (PT)", email: "dfiorella85@gmail.com", slackId: null },
  "AAM": { name: "Aadi Mehta", email: "aadim8274@gmail.com", slackId: "U0BR52XJH60" },
  "AAR": { name: "Alex Arrigoni", email: "arrigoni.alex@yahoo.com", slackId: "U0BRVKEARDW" },
  "ABA": { name: "Abdul Ashraf", email: "abdulrahim97@icloud.com", slackId: "U0BRVLMPAN4" },
  "ABF": { name: "Abraham Frem Arreola", email: "abrahamfrema@gmail.com", slackId: null },
  "ABU": { name: "Anna Busatto", email: "annabusatto96@gmail.com", slackId: "U0BQV3TRR0T" },
  "ABY": { name: "Adarius Begay", email: "abegay3853@gmail.com", slackId: "U0BQXHF1N4V" },
  "ACL": { name: "Achilleas Liapakis", email: "liapakis@outlook.com", slackId: "U0BQNA8HX96" },
  "ADR": { name: "Andrew Rodriquez", email: "Rodriguez.andrew004@gmail.com", slackId: "U0BQKV19AR5" },
  "ADW": { name: "Austin Dwyer", email: "austin041097@gmail.com", slackId: "U0BPU00FJBC" },
  "AED": { name: "Andre Edgerton", email: "aedgerton26@gmail.com", slackId: "U0BR37LLE65" },
  "AEV": { name: "Andrew Evans", email: "aevans1110@yahoo.com", slackId: "U0BQV229LTD" },
  "AGA": { name: "Arturo Garcia", email: "arturxrf@gmail.com", slackId: "U0BQL0MUW1M" },
  "AGO": { name: "Alex Gormley", email: "alex.n.gormley@gmail.com", slackId: "U0BPVTLU1CZ" },
  "AGY": { name: "Alvin Gulley Jr", email: "alvin.gulley@aya.yale.edu", slackId: "U0BQKV91CS3" },
  "AHN": { name: "Andrew Hanson", email: "83hansona@gmail.com", slackId: "U0BQXHRCXTP" },
  "AHO": { name: "Adam Honti", email: "hontesz1027@gmail.com", slackId: "U0BR3890FPT" },
  "AHW": { name: "Adam Hartwick", email: "Hartwick1978@gmail.com", slackId: "U0BRVL08CM6" },
  "AIN": { name: "Anthony Intorcia", email: "aintorcia1085@gmail.com", slackId: "U0BQL0FTP6K" },
  "AIU": { name: "Aidan Ulin", email: "aidanulin3@gmail.com", slackId: null },
  "AJC": { name: "Alexander Cola", email: "Alexanderjcola@gmail.com", slackId: "U0BPXLF7DNY" },
  "AKD": { name: "Ákos Dócs", email: "docsakos97@gmail.com", slackId: null },
  "AKG": { name: "Akos Gluck", email: "gluckakos99@gmail.com", slackId: "U0BRVKJ5M7S" },
  "AKK": { name: "Ákos Kohut", email: "increay@gmail.com", slackId: "U0BPQBGU753" },
  "AKO": { name: "Alexander Kokat", email: "Akokat@comcast.net", slackId: "U0BRVKG8GJC" },
  "AKZ": { name: "Attila Kozma", email: "kozma.attila88@gmail.com", slackId: "U0BQKT0UV71" },
  "ALC": { name: "Alyssa Christensen", email: "achriste0@gmail.com", slackId: "U0BQXKYGQMB" },
  "ALG": { name: "Alexandre Gauvreau", email: "gauvalexou@hotmail.com", slackId: "U0BQV319TH9" },
  "ALL": { name: "Alexander Louvier", email: "alexlouvier@yahoo.com", slackId: "U0BQV4BCGRH" },
  "ALP": { name: "Allan Paiz", email: "allan.paiz0@gmail.com", slackId: null },
  "ALS": { name: "Alexander Slagle", email: "slagle.alexd@gmail.com", slackId: "U0BQV4GF7DZ" },
  "ALV": { name: "Alex Levy", email: "alex.j.levy@gmail.com", slackId: "U0BR37Z6P17" },
  "AMA": { name: "Alex Markowski", email: "Alexmarkowski340@gmail.com", slackId: "U0BPVU3M02D" },
  "AMN": { name: "Andrew Melton", email: "amelton2525@yahoo.com", slackId: "U0BQNACT4AC" },
  "AMT": { name: "Alistair Martin Matheson", email: "a.m.matheson@hotmail.com", slackId: "U0BR4UTSFD2" },
  "ANA": { name: "Anthony Amsbaugh", email: "tony.amsbaugh@gmail.com", slackId: "U0BPTUSU56E" },
  "ANB": { name: "Andrew Brinker", email: "andrewbrinker22@gmail.com", slackId: null },
  "ANC": { name: "Anthony Cellitti", email: "cellitti8180@comcast.net", slackId: "U0BQZAR2MRC" },
  "ANV": { name: "Andreas Villa Gavaldon", email: "dresvilla@gmail.com", slackId: "U0BQZB4R5JA" },
  "ANW": { name: "Anthony Whited", email: "anthonyblakewhited@gmail.com", slackId: "U0BQKUZHYSK" },
  "AOD": { name: "Andrew O'Donnell", email: "andrewodo111@gmail.com", slackId: "U0BQNAVJZC0" },
  "AOS": { name: "Aidan O'Shea", email: "Aidano0825@gmail.com", slackId: "U0BR52LQE5S" },
  "APT": { name: "Alex Putman", email: "alexputman2209@gmail.com", slackId: null },
  "ARC": { name: "Arden Chen", email: "aac@ucsb.edu", slackId: "U0BR19QR7MG" },
  "ARZ": { name: "Áron Rozsics", email: "aron.rozsics@gmail.com", slackId: null },
  "ASA": { name: "Austin Sanderson", email: "austinsanderson4@gmail.com", slackId: "U0BRVM0GXEC" },
  "ASK": { name: "Andras Strupka", email: "andras.strupka@gmail.com", slackId: null },
  "ASW": { name: "Alex Swift", email: "Adfastly@gmail.com", slackId: "U0BR50Y6L5S" },
  "ASY": { name: "Austin Silvoy", email: "austinsilvoy@gmail.com", slackId: "U0BPS0W1APQ" },
  "ATH": { name: "Anthony Thivener", email: "tthivjr@gmail.com", slackId: "U0BQZBLH3AS" },
  "ATI": { name: "Alexander Tiedeman", email: "xandert131313@icloud.com", slackId: "U0BR1BC6P0A" },
  "ATS": { name: "Austin Strolle", email: "austin.strolle@gmail.com", slackId: null },
  "ATW": { name: "Avery Thomas-Wells", email: "athomaswells@yahoo.com", slackId: null },
  "AUG": { name: "Austin Gore", email: "awgore99@gmail.com", slackId: "U0BQKTKFD39" },
  "AVH": { name: "Aviv Harel", email: "avivharel3@gmail.com", slackId: null },
  "AWA": { name: "Avery Wash", email: "awash950@yahoo.com", slackId: "U0BPMNWSRMZ" },
  "AWS": { name: "Andrew Stewart", email: "abstewart01@gmail.com", slackId: "U0BPVTGH1AM" },
  "AXC": { name: "Alexander Chen", email: "alexchen228@yahoo.com", slackId: "U0BQKT5FK6K" },
  "AXH": { name: "Alex Hill", email: "alex.michael.hill.94@gmail.com", slackId: null },
  "BAB": { name: "Böröczky Bálint", email: "boroczkybalint1@gmail.com", slackId: "U0BPTV107T4" },
  "BAF": { name: "Balázs Frankó", email: "franko.balazs12@gmail.com", slackId: "U0BPS1CLJS2" },
  "BBE": { name: "Brett Berenson", email: "brettberenson@gmail.com", slackId: "U0BQV4QSNKV" },
  "BBU": { name: "Bradley Burk", email: "burkb2003@gmail.com", slackId: "U0BQL13BVJT" },
  "BCY": { name: "Brandon Cosby", email: "brandon.cosby2@gmail.com", slackId: "U0BR38Y8VA5" },
  "BDA": { name: "Brennan Darr", email: "badarr03@gmail.com", slackId: "U0BPS14HYGN" },
  "BDE": { name: "Brent Dewald", email: "sockafar1@outlook.com", slackId: null },
  "BDF": { name: "William (Billy) Duff", email: "williamd1390@gmail.com", slackId: "U0BQKT452MD" },
  "BEI": { name: "Benjamin Eiler", email: "beneiler9@gmail.com", slackId: null },
  "BER": { name: "Benjámin Régeisz", email: "regeisz.beni@gmail.com", slackId: "U0BR39GAXU1" },
  "BES": { name: "Ben Safos", email: "bensafos@gmail.com", slackId: "U0BR52K8GSG" },
  "BFX": { name: "Brandon Fox", email: "bfox0601@icloud.com", slackId: "U0BQV4AHRS7" },
  "BHF": { name: "Benjamin Joseph Hoffman", email: "hoffman.benjamin@yahoo.com", slackId: "U0BQNA813T2" },
  "BHU": { name: "Benjamin Hunt", email: "Bhunt744b@gmail.com", slackId: "U0BPMP0PLN7" },
  "BHY": { name: "Broderick Hyatt", email: "broderickhyatt@gmail.com", slackId: "U0BR1A0RVK4" },
  "BJW": { name: "Benjamin Wilson", email: "benwilsonfb12@gmail.com", slackId: "U0BPQC80R4M" },
  "BKE": { name: "William Kennedy", email: "wjkennedy1116@gmail.com", slackId: "U0BR1BA7066" },
  "BKG": { name: "Brandon King", email: "Kingbl231@yahoo.com", slackId: null },
  "BLC": { name: "Blair Carden", email: "blaircarden@gmail.com", slackId: null },
  "BMG": { name: "Brendan McGuinness", email: "brendan.f.mcguinness@gmail.com", slackId: null },
  "BMH": { name: "Brett Mahoney", email: "bmahoney152@gmail.com", slackId: "U0BR18R3AE6" },
  "BNK": { name: "Bence Kovács", email: "bence.kovacs.01.29@gmail.com", slackId: null },
  "BOP": { name: "George Benjamin Opdyke", email: "gopdyke@gmail.com", slackId: "U0BQN9ZK2KA" },
  "BR": { name: "Brent Rollins", email: "brollinspff@gmail.com", slackId: null },
  "BRB": { name: "Brad Beatson", email: "bjbeatson@gmail.com", slackId: "U0BQXHMHY77" },
  "BRC": { name: "Brandon Corbin", email: "coach.b.corbin@gmail.com", slackId: "U0BR18NG2F4" },
  "BRD": { name: "Bryce Dunlap", email: "bdunlap2@elon.edu", slackId: null },
  "BRE": { name: "Bradley Reed", email: "bradleyjreed2@gmail.com", slackId: "U0BQXL590KX" },
  "BRF": { name: "Brandyn Furr", email: "Brandyn.furr@yahoo.com", slackId: "U0BQXHBG7GV" },
  "BRJ": { name: "Bryan Johnson", email: "johnsonbryan925@gmail.com", slackId: null },
  "BRL": { name: "Brendan Lamanna", email: "bjlamanna6@gmail.com", slackId: "U0BRVK7ADCY" },
  "BRM": { name: "Bradley McGarvin", email: "Bmcgarvin88@yahoo.com", slackId: null },
  "BRS": { name: "Braden Sargent", email: "sargent.braden@yahoo.com", slackId: null },
  "BSO": { name: "Brian Solway", email: "bsolway1@gmail.com", slackId: "U0BQXL2HUKX" },
  "BST": { name: "Brett Stoey", email: "brettstoey@gmail.com", slackId: null },
  "BTU": { name: "Brandon Turner", email: "brandon.ucf16@gmail.com", slackId: "U0BRVMQRKK2" },
  "BVL": { name: "Benjamin Volpe", email: "volpe.ben020@gmail.com", slackId: null },
  "BVO": { name: "Bence Vörös", email: "vorosbence981118@gmail.com", slackId: "U0BR5249E5A" },
  "BWA": { name: "Braden Watts", email: "wattsbrady2@gmail.com", slackId: "U0BQKVA0DGF" },
  "BWK": { name: "Benjamin Winkler", email: "b7winkler@gmail.com", slackId: null },
  "BYL": { name: "Bryce Locust", email: "brycelocust2015@gmail.com", slackId: "U0BPCJSGCRM" },
  "BZS": { name: "Balazs Suranyi", email: "suranyi.balazs.23@gmail.com", slackId: null },
  "CAR": { name: "Caitlin Ree", email: "caitlinree45@gmail.com", slackId: "U0BRVMFNZSL" },
  "CBK": { name: "Charlie Baker", email: "charliehustlefive@gmail.com", slackId: "U0BR18YCW66" },
  "CBR": { name: "Connor Barie", email: "barieconnor32@gmail.com", slackId: null },
  "CCA": { name: "Christofero Campitelli", email: "Campitellichris@gmail.com", slackId: "U0BR18P2U3U" },
  "CCR": { name: "Connor Crafton", email: "ccrafton25@outlook.com", slackId: "U0BR38MKSHF" },
  "CDE": { name: "Christopher Decker", email: "chrisdecker0804@gmail.com", slackId: "U0BQZCD8L1L" },
  "CDG": { name: "Chris DelGuercio", email: "cdelguer21@gmail.com", slackId: "U0BR50HRMM2" },
  "CDO": { name: "Carter Dorow", email: "cdorow612@gmail.com", slackId: null },
  "CFI": { name: "Connor Fingeroos", email: "fingeroosconnor@gmail.com", slackId: "U0BQKUWHHD5" },
  "CFY": { name: "Carson Fraley", email: "carsonfraley10@gmail.com", slackId: "U0BRVNE00E4" },
  "CGE": { name: "Christopher Geier", email: "geier_c1@denison.edu", slackId: "U0BR1AGMBGS" },
  "CGG": { name: "Cristiana Garguillo", email: "cristieg22m@gmail.com", slackId: "U0BQXJQUVSR" },
  "CGO": { name: "Christian Gonzalez", email: "chris.gonz1744@gmail.com", slackId: null },
  "CGR": { name: "Christopher Grissom", email: "topgcg@gmail.com", slackId: "U0BR37B11J5" },
  "CHF": { name: "J Connor Hoffman", email: "connorjhoffman@gmail.com", slackId: "U0BQV1HQSBD" },
  "CHG": { name: "Christopher Gagnon", email: "christopherdavidgagnon@hotmail.com", slackId: null },
  "CHI": { name: "Carson Hise", email: "Carsonhise4@gmail.com", slackId: "U0BRVM1R63S" },
  "CHO": { name: "Charles Hoffman", email: "charles.hoffman13@yahoo.com", slackId: "U0BR19A9VDY" },
  "CHT": { name: "Chase Tuggle", email: "chasetuggle2@gmail.com", slackId: "U0BQV3J43LK" },
  "CHW": { name: "Chris Wood", email: "chrispw225@gmail.com", slackId: "U0BPQBV3GJH" },
  "CKI": { name: "Correy King", email: "correyking@outlook.com", slackId: "U0BQV1ZKXU3" },
  "CLA": { name: "Corey Lam", email: "clam382200@gmail.com", slackId: "U0BQXJ8V3BP" },
  "CLC": { name: "Charles Lachman", email: "charleslachman4@gmail.com", slackId: "U0BQZCUTP0E" },
  "CLG": { name: "Cory J Lagner", email: "Cory.lagner@gmail.com", slackId: null },
  "CLM": { name: "Clint Miller", email: "Clintlmiller@gmail.com", slackId: "U0BPXLJKLP6" },
  "CLV": { name: "Cody Loveday", email: "codydavidloveday95@gmail.com", slackId: "U0BQKV52QEB" },
  "CML": { name: "Cole Mills", email: "colegdmills@gmail.com", slackId: "U0BRVN1SD1N" },
  "CMN": { name: "Chris Monroe", email: "cdmonroe92@gmail.com", slackId: "U0BQNA3PW5N" },
  "CNH": { name: "Connor Hart", email: "connorthart@gmail.com", slackId: "U0BQZCQULES" },
  "COA": { name: "Calvin Oates", email: "oates.cu2@gmail.com", slackId: "U0BRVM266AU" },
  "COB": { name: "Colin Bartolin", email: "2chilllee@gmail.com", slackId: null },
  "COF": { name: "Connor Finley", email: "cwildefinley@gmail.com", slackId: null },
  "COL": { name: "Colyn Leary", email: "colynjleary@gmail.com", slackId: "U0BR4UJRX60" },
  "COR": { name: "Cody Ortloff", email: "codyortloff6@gmail.com", slackId: null },
  "CPL": { name: "Christopher Plaster", email: "cdplaster@gmail.com", slackId: "U0BQZBNU35L" },
  "CPR": { name: "Cortize Pryor", email: "cortizepryor23@gmail.com", slackId: "U0BQXL5LFHB" },
  "CRL": { name: "Craig Lakins", email: "Clakins1@gmail.com", slackId: "U0BR4UUQDSQ" },
  "CS": { name: "Cole Schultz", email: "colemschultz@gmail.com", slackId: "U0BPS1GRY3Y" },
  "CSE": { name: "Collin Setzer", email: "csetz979@live.kutztown.edu", slackId: null },
  "CSH": { name: "Charles Shuford", email: "ceshuf@gmail.com", slackId: "U0BR518R8E8" },
  "CSL": { name: "Christopher Slone", email: "slone.christopher@gmail.com", slackId: "U0BR390B4EM" },
  "CSQ": { name: "Chris Saqqal", email: "chrissaqqal@gmail.com", slackId: "U0BR516P7DJ" },
  "CSY": { name: "Chris Shelby", email: "chrisgshelby@gmail.com", slackId: "U0BR1A054FL" },
  "CSZ": { name: "Csaba Szabo", email: "focibacsi0@gmail.com", slackId: null },
  "CTB": { name: "Copernicus Tablate", email: "Copernicus.tablate@gmail.com", slackId: "U0BPS0RA4TG" },
  "CTI": { name: "Carson Timberlake", email: "carsontimberlake@gmail.com", slackId: null },
  "CTM": { name: "Chester Daniel Matney", email: "dmatney15@gmail.com", slackId: null },
  "CTS": { name: "Chris Shores", email: "chrisdshores@gmail.com", slackId: null },
  "CTU": { name: "Chaz Turnbow", email: "chaz.turnbow@yahoo.com", slackId: "U0BQV43RF8T" },
  "CUL": { name: "Coltt Ullom", email: "Colttullom@gmail.com", slackId: null },
  "CYL": { name: "Corey Lord", email: "cslord.cor@gmail.com", slackId: "U0BQXJ7TBT7" },
  "CYO": { name: "Carson You", email: "carsonayou@gmail.com", slackId: "U0BQV3V271R" },
  "CYZ": { name: "Cody Zanga", email: "cjzanga1@gmail.com", slackId: "U0BQZBJV80N" },
  "CZA": { name: "Christian Zahn", email: "hebrews1996@gmail.com", slackId: "U0BQL0W2EK1" },
  "DAJ": { name: "Daniel Jackson", email: "teamtexas96@gmail.com", slackId: null },
  "DAU": { name: "Daniel Arrucci", email: "darrucci1@gmail.com", slackId: "U0BQZBK3SBG" },
  "DBI": { name: "David Biró", email: "birodavid89@gmail.com", slackId: "U0BPMNMEYGK" },
  "DBW": { name: "Daren Baldwin", email: "darenbaldwin838@gmail.com", slackId: "U0BRVL547U0" },
  "DCA": { name: "Daniel Callahan", email: "Dlcallahan94@gmail.com", slackId: null },
  "DCG": { name: "Daniel Colgate", email: "mail@danielcolgate.com", slackId: "U0BPXL9JUUC" },
  "DCL": { name: "Dominic Colapietro", email: "dominic.colapietro2@gmail.com", slackId: null },
  "DCR": { name: "Daire Carragher", email: "dairecarragher1@icloud.com", slackId: "U0BQXGP17AR" },
  "DCV": { name: "Dominic Cava", email: "domcava28@gmail.com", slackId: "U0BQNAC0R40" },
  "DCY": { name: "Devyn Cary", email: "devync@rocketmail.com", slackId: "U0BR1959YHY" },
  "DDA": { name: "Dalton Daniels", email: "dan384825@gmail.com", slackId: null },
  "DED": { name: "Daniel Edwards", email: "edwardsdaniel19@gmail.com", slackId: null },
  "DFL": { name: "Damian Floyd II", email: "dfloyd128@gmail.com", slackId: "U0BR51GP868" },
  "DFR": { name: "Ferencz Dávid", email: "david.ferenc01@gmail.com", slackId: null },
  "DGA": { name: "David Gal", email: "davidqan@gmail.com", slackId: "U0BR38W8F09" },
  "DGD": { name: "Dávid Gergely Dankó", email: "danko.david.gergely@gmail.com", slackId: "U0BQV1V4Q1H" },
  "DGL": { name: "Dan Glozier", email: "d.glozier66@gmail.com", slackId: "U0BQZAN98KY" },
  "DGO": { name: "Devan Gomes", email: "devangomes08@yahoo.com", slackId: null },
  "DGV": { name: "Dániel Gábor Vankó", email: "vankodaniel97@gmail.com", slackId: null },
  "DHI": { name: "David Hilbert", email: "dhilbert62@gmail.com", slackId: "U0BPTUSBM7C" },
  "DHO": { name: "Donald Houghton", email: "donnyhoughton@gmail.com", slackId: null },
  "DHS": { name: "David Hurst", email: "hurstd89@gmail.com", slackId: "U0BQXJA5KCM" },
  "DJA": { name: "Devin Jasso", email: "djasso911@gmail.com", slackId: "U0BQXJM096Z" },
  "DKA": { name: "David Kauffman", email: "dgkauffman97@gmail.com", slackId: "U0BPVUBEGGH" },
  "DKO": { name: "David Kovacs", email: "kovacs.david.adam@gmail.com", slackId: "U0BPTUN36AW" },
  "DKV": { name: "Dávid Kovács", email: "kovacsdavid.kkt@gmail.com", slackId: "U0BPTV941QS" },
  "DLA": { name: "Davide Lavarra", email: "davelavarra@yahoo.it", slackId: "U0BPQBFRM7X" },
  "DLL": { name: "Diego Lozano León", email: "loz.die41@gmail.com", slackId: "U0BQNAFQH88" },
  "DLM": { name: "Daniel Monroe", email: "danielhmonroe@gmail.com", slackId: "U0BQXJZH129" },
  "DMD": { name: "David Araiza Moncada", email: "lucas_31793@hotmail.com", slackId: "U0BQL1BFWGP" },
  "DME": { name: "Dominik Ecker", email: "eckerd05@gmail.com", slackId: "U0BR51945U4" },
  "DMI": { name: "David Michels", email: "davidjmichels@gmail.com", slackId: null },
  "DMO": { name: "Daniel Molnar", email: "molnard0509@gmail.com", slackId: "U0BPMNR7QE7" },
  "DNM": { name: "Danny Murray", email: null, slackId: null },
  "DOK": { name: "Derek Okrie", email: "dtokrie@yahoo.com", slackId: "U0BQL0BVAS3" },
  "DOL": { name: "Darren Olson", email: "darren.olson@yahoo.com", slackId: "U0BR19ZTGKU" },
  "DSI": { name: "Daniel Single", email: "dsingle@vols.utk.edu", slackId: "U0BR39JAHL1" },
  "DSO": { name: "Dan Sofranko", email: "dansofranko22@gmail.com", slackId: "U0BR1AF2YH0" },
  "DSZ": { name: "David Ferenc Szager", email: "szagerdavid@gmail.com", slackId: "U0BQKV723BR" },
  "DTO": { name: "Dániel Tóth", email: "toth11daniel@gmail.com", slackId: "U0BPXL17W4C" },
  "DVI": { name: "Diego Armando Villa Domínguez", email: "diego.villa99@hotmail.com", slackId: "U0BQV2TMVGT" },
  "DWL": { name: "Dillon Wall", email: "dillonwallsvcs@gmail.com", slackId: null },
  "DYC": { name: "Daymen Cox", email: "daymen30027@gmail.com", slackId: "U0BR38MCWP3" },
  "DYN": { name: "Dylan Nassau", email: "dnassau@umich.edu", slackId: "U0BR19WR5NE" },
  "DYR": { name: "Dylan Runion", email: "dylanrunionm@gmail.com", slackId: "U0BRVMMBQ2U" },
  "DZM": { name: "Denzel Motley", email: "dmotfitness80@gmail.com", slackId: "U0BR1A29K3L" },
  "EBE": { name: "Eric Bergevin", email: "ericb028@gmail.com", slackId: "U0BR19FQTNE" },
  "EBO": { name: "Eli Bookstaber", email: "ebookstaber@gmail.com", slackId: "U0BR19FBD0A" },
  "EDC": { name: "Edwin Caraballo", email: "edwinjr107@gmail.com", slackId: "U0BRVM3KJD6" },
  "EDV": { name: "Eddie DAvanzo", email: "eddied2405@yahoo.com", slackId: null },
  "EDW": { name: "Eli Dawson", email: "ewdawson888@gmail.com", slackId: "U0BPCJDGSNB" },
  "EEH": { name: "Erik Ehasz", email: "ehasz1215@yahoo.com", slackId: null },
  "EFD": { name: "Ethan Friedman", email: "ethanfr123@gmail.com", slackId: "U0BRVMPPGMN" },
  "EFI": { name: "Evan Finger", email: "Evanj.finger@outlook.com", slackId: null },
  "EFR": { name: "Eric Fridenberg", email: "efridenb@gmail.com", slackId: null },
  "EGM": { name: "ERIk Guzmán Mendoza", email: "erikguzmanmendoza@gmail.com", slackId: "U0BR51Q15U4" },
  "EJH": { name: "Eli Halverson", email: "halversoneli@gmail.com", slackId: "U0BQV1JDT7D" },
  "ELR": { name: "Elliott Rooney", email: "elliottrooney11@yahoo.com", slackId: "U0BR1AGC9QA" },
  "EPE": { name: "Eric Perrier", email: "perrieric54@gmail.com", slackId: null },
  "EPV": { name: "Eric Polverari", email: "ericpolverari@gmail.com", slackId: "U0BRVN698BS" },
  "EPZ": { name: "Eliana Pieprz", email: "elianapieprz@gmail.com", slackId: "U0BPMP030MR" },
  "ERP": { name: "David Pool", email: "dericpool@gmail.com", slackId: "U0BQL0HE2J3" },
  "ETB": { name: "Ethan Bench", email: "ebench0611@gmail.com", slackId: "U0BR37F1GD7" },
  "ETF": { name: "Ethan Franklin", email: "ethanrf29@gmail.com", slackId: null },
  "ETV": { name: "Ethan Vogelman", email: "evogelman0510@gmail.com", slackId: "U0BQZDDMFE2" },
  "EVB": { name: "Evan Block", email: "evanjblock@gmail.com", slackId: null },
  "EVC": { name: "Evan Cornette", email: "evan.cornette21@gmail.com", slackId: null },
  "EVS": { name: "Evan Stringfellow", email: "evan.stringfellow@outlook.com", slackId: "U0BQZCT50HL" },
  "EWA": { name: "Ethan Ward", email: "ethanfortelt21@icloud.com", slackId: null },
  "EWI": { name: "Eric Thomas Wilber", email: "ericthomaswilber@gmail.com", slackId: "U0BQNA37VCG" },
  "EWO": { name: "Ethan Woodie", email: "ethan.m.woodie@gmail.com", slackId: null },
  "FB": { name: "Frank Blanchard", email: "frank.m.blanchard@gmail.com", slackId: "U0BQXHEPLKX" },
  "FCL": { name: "Frid Cedric Lebreton", email: "ced.lebre2@gmail.com", slackId: "U0BRVLP7ZFA" },
  "FDM": { name: "Frankie DeMarco", email: "frankiepdemarco@gmail.com", slackId: null },
  "FY": { name: "Frank Yi", email: "FrankTYi@gmail.com", slackId: "U0BR1BASGMQ" },
  "GAI": { name: "Garrett Isenbarger", email: "isenbargergarrett6161@gmail.com", slackId: "U0BPCJW8CNT" },
  "GBA": { name: "Grant Backhaus", email: "backhausgrant@gmail.com", slackId: "U0BPQBFJRK7" },
  "GBE": { name: "George Beyrer", email: "gbbeyrer@gmail.com", slackId: "U0BR19FQ63C" },
  "GBI": { name: "Gabriel Igbokwe", email: "gabrielbokwe@gmail.com", slackId: "U0BQV45G0RZ" },
  "GBK": { name: "Gavin Baskette", email: "Gavinmbaskette2001@gmail.com", slackId: "U0BQV25JR1R" },
  "GBL": { name: "Garrett Black", email: "garrettgblack@gmail.com", slackId: null },
  "GGC": { name: "Gregory Carter II", email: "gregorycarter52@gmail.com", slackId: "U0BR38N4VL1" },
  "GGD": { name: "Gergely Dornyei", email: "dornyei.g97@gmail.com", slackId: "U0BR38KRGKT" },
  "GHA": { name: "Gonzalo Haro", email: "harogonzalo05@gmail.com", slackId: "U0BPMNLVA1H" },
  "GHI": { name: "George Hinckley", email: "georgemhinckley@gmail.com", slackId: "U0BPCJRKPGX" },
  "GHL": { name: "Gergo Halasi", email: "hgerho2727@gmail.com", slackId: "U0BQXK5H5C5" },
  "GHO": { name: "Grace Hoover", email: "grace.o.hoover@gmail.com", slackId: "U0BRVKRB3RN" },
  "GIG": { name: "Garin Igros", email: "garin.igros@gmail.com", slackId: "U0BPVTU3LLR" },
  "GKO": { name: "Garen Koutoujian", email: "garenkoutoujian@gmail.com", slackId: null },
  "GM": { name: "Gordon McGuinness", email: "gordonmcguinness1986@gmail.com", slackId: "U0BR39AMHQR" },
  "GMA": { name: "Gábor Magyar", email: "gabor.magyar91@gmail.com", slackId: "U0BQNA77E5N" },
  "GMC": { name: "Gavin Mcdavid", email: "andersonfairhope@gmail.com", slackId: "U0BR1A0769G" },
  "GMK": { name: "Georgi Markov", email: "georgimarkov5@gmail.com", slackId: "U0BQV3XDYRZ" },
  "GNG": { name: "Gábor Nagy", email: "nagygabr@gmail.com", slackId: "U0BQNAUCFK2" },
  "GOB": { name: "Grayson Obey", email: "grayson.r.obey@gmail.com", slackId: null },
  "GPT": { name: "Grant Potter", email: "grantpotter256@gmail.com", slackId: "U0BQXK3VCSH" },
  "GRE": { name: "Gavin Reupert", email: "Reupsgavin50@gmail.com", slackId: "U0BPQBKSF6Z" },
  "GSJ": { name: "Gergő Sajtos", email: "gergo.sajtos5@gmail.com", slackId: "U0BPXLDDBKN" },
  "GSU": { name: "Geoffrey Sundstrom", email: "gsund6@gmail.com", slackId: "U0BPQBFBWF7" },
  "HBN": { name: "Hedly Berg Nilsen", email: "Hedlybergnilsen@gmail.com", slackId: "U0BQV4M7551" },
  "HCL": { name: "Hunter Colburn", email: "hcolburn.ailcfl@gmail.com", slackId: "U0BPMNLLQV9" },
  "HDS": { name: "Haddon Shively", email: "shivelyhaddon@gmail.com", slackId: "U0BQZCMRBP0" },
  "HFN": { name: "Hildebrando Candido Ferreira Neto", email: "hfneto84@gmail.com", slackId: "U0BPQC21BM3" },
  "HGO": { name: "Hunter Gould", email: "tomahawksport@yahoo.com", slackId: "U0BR507F0UU" },
  "HGU": { name: "Henry Guerra", email: "henryg324@yahoo.com", slackId: null },
  "HKD": { name: "Henock Kidane", email: "kidane.henock@gmail.com", slackId: "U0BRVMSQL00" },
  "HKR": { name: "Hugh Kromer", email: "Hugh.kromer@yahoo.com", slackId: null },
  "HS": { name: "Harley Sherman", email: "harleysherman257@live.co.uk", slackId: "U0BR1AFAGMQ" },
  "HST": { name: "Hunter Stahl", email: "stahltyl@msu.edu", slackId: "U0BPS136PAA" },
  "HTO": { name: "Hassan Torres", email: "hassan06jaik@gmail.com", slackId: "U0BR1AJ71CJ" },
  "JAD": { name: "Jake Adkins", email: "jakesteedoff@gmail.com", slackId: "U0BQKUXCCET" },
  "JAH": { name: "Jaxson Hinkens", email: "jhinkens1699@gmail.com", slackId: "U0BQKTACLK1" },
  "JAL": { name: "Jesus Alemon", email: "andresbermudez296@gmail.com", slackId: "U0BR1ABUJKU" },
  "JAM": { name: "Jake Macauley", email: "jake.c.macauley@gmail.com", slackId: "U0BR50CJPBN" },
  "JAV": { name: "Javon McCrary", email: "javon1144@icloud.com", slackId: null },
  "JAW": { name: "Jack Wilson", email: "jwilly33@g.ucla.edu", slackId: "U0BQV3VHE8K" },
  "JBA": { name: "Joe Barreras", email: "barrerasjoe127@gmail.com", slackId: "U0BPCJD4GS3" },
  "JBR": { name: "Jorge Gomez", email: "jorgebrehmjb@gmail.com", slackId: "U0BR1AP190A" },
  "JBS": { name: "Jaden Bullard Santiago", email: "bullardjaden@gmail.com", slackId: null },
  "JBT": { name: "Joshua Barthe", email: "barthevader30@gmail.com", slackId: "U0BR390HFT3" },
  "JBW": { name: "Jaron Brown", email: "brownjaron18@gmail.com", slackId: null },
  "JBY": { name: "Jonah Byther", email: "jonah.byther@gmail.com", slackId: "U0BR195LQAW" },
  "JBZ": { name: "Joel Benzie", email: "Benziejoel@gmail.com", slackId: "U0BR4USDTUL" },
  "JCH": { name: "Jimmy Chieffo", email: "jimmychieffo@gmail.com", slackId: "U0BR519Q89J" },
  "JCM": { name: "Jacob Miller", email: "jakedmiller18@gmail.com", slackId: "U0BR1A3LZ26" },
  "JCT": { name: "Joseph Costello", email: "Jcostello275@yahoo.com", slackId: "U0BPXLHJBJQ" },
  "JCX": { name: "Jack Cox", email: "jack.c_07@msn.com", slackId: "U0BPS0UR2B0" },
  "JCY": { name: "Jaden Cuypers", email: "Jaden.cuypers@gmail.com", slackId: null },
  "JD": { name: "Jeff Deeney", email: "jeffdeeney@gmail.com", slackId: "U0BQKUM1T9V" },
  "JDA": { name: "Josh Dahlberg", email: "dahlbergjosh0@gmail.com", slackId: "U0BQXJC3M29" },
  "JDO": { name: "Joel Donskey", email: "Jdonskey@gmail.com", slackId: "U0BQV2KC719" },
  "JDS": { name: "Joseph Desena", email: "josephdesena2@gmail.com", slackId: "U0BRVMJ5MA4" },
  "JDV": { name: "Jordan Diven", email: "jdiven91@gmail.com", slackId: null },
  "JEB": { name: "Jeff Barto", email: "jeff.barto@live.com", slackId: null },
  "JEV": { name: "Jason Holt Everett", email: "jasonholteverett@yahoo.com", slackId: null },
  "JFA": { name: "Jordan Farias", email: "jordanmfarias@gmail.com", slackId: "U0BQZDAJE78" },
  "JFR": { name: "Joshua Franco", email: "joshuafranco1313@gmail.com", slackId: "U0BQKUHLHFZ" },
  "JFW": { name: "Jeffrey Wilson", email: "jeffreywilson83@gmail.com", slackId: "U0BQZCSABQE" },
  "JGI": { name: "Justin Gidwani", email: "jjgidwani@gmail.com", slackId: "U0BQV3UT527" },
  "JGL": { name: "James Galvin", email: "jmgalvin55@gmail.com", slackId: "U0BQNAPL7NU" },
  "JGR": { name: "Johann Grayson", email: "johanngrayson5@gmail.com", slackId: "U0BPTUGTGTC" },
  "JGY": { name: "Jared Gray", email: "jmgray2004@gmail.com", slackId: "U0BR39GCWL9" },
  "JGZ": { name: "Jacob Gonzalez", email: "jacobgonzalez.alv@gmail.com", slackId: null },
  "JHA": { name: "Joshua Hansen", email: "joshua.p.hansen@gmail.com", slackId: "U0BPCJM4TK9" },
  "JHB": { name: "Josh Bethas", email: "jbethas@ycp.edu", slackId: "U0BR18FGREE" },
  "JHK": { name: "Johnathon Kulich", email: "kulichjohnathon@gmail.com", slackId: "U0BQKTHAGDV" },
  "JHO": { name: "Jackson Howarth", email: "jhowarth11@yahoo.com", slackId: null },
  "JHU": { name: "Julian Houston", email: "julianhouston7@gmail.com", slackId: "U0BR4VCDUMS" },
  "JHW": { name: "Jacob Walling", email: "jwallthing@gmail.com", slackId: null },
  "JKH": { name: "Jack Herman", email: "jrherman0202@gmail.com", slackId: "U0BR18AV44A" },
  "JLR": { name: "Jacob Larose", email: "jakelarose8@gmail.com", slackId: "U0BQZB1S7HU" },
  "JMA": { name: "Joseph Martin", email: "joseph.e.martin215@gmail.com", slackId: "U0BR4VACXV2" },
  "JMH": { name: "James Hansen", email: "Jameshans3n@gmail.com", slackId: "U0BQV30LR5H" },
  "JMI": { name: "James Miller", email: "jamestmiller0705@gmail.com", slackId: "U0BR38VRR5X" },
  "JMM": { name: "José Mauricio Martínez Leal", email: "maumtzleal@hotmail.com", slackId: "U0BR19K4AQ2" },
  "JMO": { name: "Jamie Moran", email: "jamiemartinmoran@gmail.com", slackId: "U0BPQC1NYAH" },
  "JMR": { name: "John Moore", email: "john.moore797@yahoo.com", slackId: null },
  "JMS": { name: "James Smeltzer", email: "baileysmeltz@gmail.com", slackId: "U0BRVMM474G" },
  "JMZ": { name: "Jordan Moezidis", email: "Jordan.moezidis@yahoo.com", slackId: null },
  "JNB": { name: "Jonathan Bellamy", email: "jbellamyfootball@gmail.com", slackId: "U0BPTUVGWKC" },
  "JNM": { name: "Jason Miller", email: "jasonmiller1233@gmail.com", slackId: null },
  "JOG": { name: "Josh Goldstein", email: "joshgold1018@gmail.com", slackId: "U0BRVM2ML3S" },
  "JOL": { name: "Jace Olsen", email: "jaceolsen32@gmail.com", slackId: "U0BQV4FP72P" },
  "JOM": { name: "Johnathon Monsour", email: "jmonsour97@gmail.com", slackId: "U0BR1AY46R0" },
  "JOP": { name: "Joseph Patterson", email: "jtpatterson2ms@gmail.com", slackId: null },
  "JOR": { name: "Jared Orman", email: "jorman@udel.edu", slackId: null },
  "JOY": { name: "Jon Yeager", email: "Jonyeager37@yahoo.com", slackId: "U0BPXKW92BE" },
  "JPI": { name: "Justin Pitt", email: "jmpitt64@gmail.com", slackId: "U0BRVNM9U72" },
  "JPR": { name: "Justin Pretorius", email: "justindpretorius123@gmail.com", slackId: null },
  "JPZ": { name: "Josh Pomerantz", email: "joshpom@umich.edu", slackId: null },
  "JRB": { name: "Jamerson Blount", email: "jabblount95@gmail.com", slackId: null },
  "JRE": { name: "Julian Reiss", email: "julianreiss4@gmail.com", slackId: "U0BQL04NPTR" },
  "JRH": { name: "Jeremiah Hughes", email: "hughesjt02@gmail.com", slackId: "U0BR526KZ7E" },
  "JRW": { name: "Jackson Reuwsaat", email: "jacksonreuwsaat1@gmail.com", slackId: "U0BQXKVD3A9" },
  "JRY": { name: "Jaime Borrego", email: "jreyesb1994@gmail.com", slackId: "U0BPCJZSLMV" },
  "JSA": { name: "Juan Sebastián sanchez", email: "Juansanchez0810@gmail.com", slackId: "U0BPVTJUZ41" },
  "JSC": { name: "Joseph Schutz", email: "joey0schutz@gmail.com", slackId: null },
  "JSG": { name: "Jason Swalga", email: "jds5050@gmail.com", slackId: null },
  "JSM": { name: "Joseph Mellor", email: "mellor.joseph@gmail.com", slackId: "U0BPXLCS7UL" },
  "JSN": { name: "Jared Sanderson", email: "Jared.sanderson75@gmail.com", slackId: "U0BPQBEP76H" },
  "JSR": { name: "Josiah Ryan", email: "josiahryan21@gmail.com", slackId: "U0BRVN89Z9N" },
  "JSU": { name: "Jay Sullivan", email: "jaysullivan657@gmail.com", slackId: null },
  "JSV": { name: "Joshua Savage", email: "jsav81684@gmail.com", slackId: "U0BPCJLTDQF" },
  "JTC": { name: "Justin Teck", email: "justinteck@gmail.com", slackId: "U0BR39EFN2D" },
  "JTH": { name: "Juan Thrasher", email: "j.thrash@me.com", slackId: "U0BR39MMN3T" },
  "JUB": { name: "Justin Bartholomew", email: "justinbartholomew03@gmail.com", slackId: "U0BR3771MBK" },
  "JUV": { name: "Justin Vineyard", email: "vineyard27@gmail.com", slackId: "U0BQV4EA9BM" },
  "JWA": { name: "Jordan Wallem", email: "jordanwallem@gmail.com", slackId: null },
  "JWH": { name: "Jack Whitehead", email: "jvwhitehead2003@gmail.com", slackId: null },
  "JWR": { name: "Joshua Warren", email: "jwarren11.fb@gmail.com", slackId: null },
  "JYM": { name: "Jaycob Menndez", email: "jaycobmendez@gmail.com", slackId: null },
  "JZP": { name: "Jonathan Zepeda", email: "Jonzepeda68@gmail.com", slackId: null },
  "KBR": { name: "Kenneth Bradley", email: "kwbradley20@gmail.com", slackId: "U0BQV3D12RH" },
  "KDI": { name: "Kyle Disselkoen", email: "kydisselkoen@gmail.com", slackId: "U0BQV3DGPJ7" },
  "KGC": { name: "Keegan Clanton", email: "Keegan.clanton4135@gmail.com", slackId: null },
  "KGD": { name: "Kegan Dimick", email: "dimickkegan@gmail.com", slackId: null },
  "KJE": { name: "Kevin Jean", email: "Kevj717@yahoo.com", slackId: "U0BPS1ALQNA" },
  "KKW": { name: "Kale Kwak", email: "kalekwak@gmail.com", slackId: "U0BQKTZTKFZ" },
  "KLL": { name: "Kaleb Logan", email: "kaleblogan344@gmail.com", slackId: "U0BQKVBTZAT" },
  "KMN": { name: "Kyle Menzynski", email: "kylemenzy@gmail.com", slackId: "U0BPCJGMF71" },
  "KNF": { name: "Kenneth Fassett", email: "kenfass2973@gmail.com", slackId: "U0BQNA6FFTJ" },
  "KON": { name: "Kevin Ondima", email: "enimbalindz@gmail.com", slackId: null },
  "KRD": { name: "Kyle Redmond", email: "kykyrtbr16@gmail.com", slackId: "U0BQZBVUKGW" },
  "KRT": { name: "Kristof Toth", email: "kristofortoth@gmail.com", slackId: "U0BQKUZ4DDM" },
  "KSP": { name: "Kyle Suppa", email: "kylesuppa@gmail.com", slackId: "U0BPTVC4P26" },
  "KSZ": { name: "Krisztián Szaradics", email: "szaradics12@gmail.com", slackId: null },
  "KTO": { name: "Kristóf Tóth", email: "toth.kristof.eger@gmail.com", slackId: "U0BQV3NAJ7M" },
  "KTW": { name: "Kingston Williams", email: "kingston_williams@outlook.com", slackId: "U0BR1A5HNJW" },
  "KUH": { name: "Kurt Hallead", email: "Kurt.hallead@gmail.com", slackId: "U0BQV3B8PEF" },
  "KYD": { name: "Kyria Degrow", email: "kyriad13@gmail.com", slackId: "U0BQXKY6WQ5" },
  "KYN": { name: "Kyle Neaveill", email: "kyleneaveill@gmail.com", slackId: "U0BQNA234BS" },
  "LCU": { name: "Lucas Cubic", email: "lucascubic@gmail.com", slackId: "U0BR37MN389" },
  "LCY": { name: "Logan Clarey", email: "loganclarey6@gmail.com", slackId: "U0BQKTN3MNK" },
  "LDA": { name: "Luca Dall'Agnese", email: "luca.dallagnese@gmail.com", slackId: null },
  "LDV": { name: "Luis Antonio Delgado Villalobos", email: "lad0050@auburn.edu", slackId: "U0BQL07JBAT" },
  "LEX": { name: "Lance Exley", email: "ljexley@outlook.com", slackId: "U0BR500AWGL" },
  "LH": { name: "Luke Hutcherson", email: "lucas.hutcherson@gmail.com", slackId: "U0BR17TPGHG" },
  "LIR": { name: "Lucas Irvine", email: "luke032288@gmail.com", slackId: null },
  "LKO": { name: "Luke Olson", email: "Olson.luke2003@gmail.com", slackId: "U0BR51NVA7N" },
  "LKS": { name: "Luke Stone", email: "lukestone067@gmail.com", slackId: "U0BR1B4QLMQ" },
  "LKW": { name: "Lucas Williams", email: "coolhandsluke33@icloud.com", slackId: "U0BQV4SAPQT" },
  "LMA": { name: "Larry Maistros", email: "saflcats@gmail.com", slackId: "U0BPS1F2W06" },
  "LMC": { name: "Luke McCabe", email: "lukemccabeyfn@gmail.com", slackId: "U0BR4UD3068" },
  "LOA": { name: "Logan Abraham", email: "allegan24@gmail.com", slackId: "U0BR50VLUMA" },
  "LPZ": { name: "Logan Pruznak", email: "Loganpruz88@gmail.com", slackId: null },
  "LRA": { name: "Luke Ransick", email: "ransiclg@mail.uc.edu", slackId: "U0BPCJ3QA23" },
  "LRE": { name: "Liam Rebellato", email: "rebellatoliam@gmail.com", slackId: "U0BR38U9F7B" },
  "LSC": { name: "Lucas Schoenecker", email: "Lucasschoenecker@outlook.com", slackId: "U0BQXJXABM3" },
  "LSP": { name: "Luke Spencer", email: "ljspencer95@gmail.com", slackId: "U0BPXL435J8" },
  "LUH": { name: "Luke Heffernan", email: "lukeheffernan17@yahoo.co.uk", slackId: "U0BR17UBKGS" },
  "LUL": { name: "Lucas Libero", email: "libelm96@gmail.com", slackId: null },
  "LVW": { name: "Levi Wingert", email: "levi.wingert@gmail.com", slackId: "U0BQXJR843X" },
  "LYA": { name: "Luke Yates", email: "luke@oconnellclan.org", slackId: "U0BR1ACV3C2" },
  "LZU": { name: "Laszlo Uray", email: "uraylaszlobusiness@gmail.com", slackId: null },
  "MAD": { name: "Michael Aland", email: "63kalel@gmail.com", slackId: "U0BQXJ6VC1K" },
  "MAG": { name: "Matthew Grosshans", email: "mmgrosshans@gmail.com", slackId: "U0BPQC17J0M" },
  "MAJ": { name: "Michael Agens Jr", email: "mickeyagens55@gmail.com", slackId: "U0BQV3LGND9" },
  "MAL": { name: "Maximus Alvir", email: "maxalvir@aol.com", slackId: null },
  "MAN": { name: "Maleik Alterno", email: "maleikalterno@gmail.com", slackId: null },
  "MAP": { name: "Marco Padley", email: "giomarco101@gmail.com", slackId: "U0BRVNMKJHE" },
  "MAX": { name: "Matias Axat", email: "matiasaxat@gmail.com", slackId: "U0BR5223GQL" },
  "MAZ": { name: "Marcell Asztalos", email: "marcell.asztalos21@gmail.com", slackId: "U0BQKTQ18BZ" },
  "MB": { name: "Michael Burland", email: "mburland89@gmail.com", slackId: "U0BQNAABA48" },
  "MCA": { name: "Michael Campbell", email: "michaelgcampbell9@gmail.com", slackId: "U0BQL0FUDT9" },
  "MCM": { name: "Mason Cameron", email: "MasonCameron.business@gmail.com", slackId: "U0BPWRPC23X" },
  "MCO": { name: "Michael Cortez", email: "coachmikec34@gmail.com", slackId: "U0BPXKVNT52" },
  "MCS": { name: "Marc Csata", email: "marcell.csata@gmail.com", slackId: null },
  "MCT": { name: "Matthew Cotner", email: "mattcotner17@gmail.com", slackId: "U0BQXGNERFX" },
  "MDA": { name: "Mark Daoud", email: "Markdaoud12@gmail.com", slackId: "U0BPTVBS1MY" },
  "MDN": { name: "Matt Donohue", email: "mattdonohue0@gmail.com", slackId: "U0BQKTM2STZ" },
  "MDU": { name: "Matthew Dustman", email: "Mattrdustman@gmail.com", slackId: null },
  "MED": { name: "Matt Elrod", email: "mattelrod73@gmail.com", slackId: "U0BQZB5GV62" },
  "MEI": { name: "Matthew Eichner", email: "mattheweichner24@gmail.com", slackId: "U0BR4UY0NCU" },
  "MEL": { name: "Máté Éliás", email: "chicagobears42@gmail.com", slackId: "U0BQV1KNDAP" },
  "MGC": { name: "Megan Clapinski", email: "meganclapinski@gmail.com", slackId: null },
  "MGD": { name: "Michael Good", email: "good.michael.e@gmail.com", slackId: "U0BQL06KZRV" },
  "MGR": { name: "Marc Grossman", email: "Marcgrossman27@gmail.com", slackId: "U0BPXKR9N2Y" },
  "MH": { name: "Mark Harrington", email: "mharrington11@gmail.com", slackId: "U0BPTV7DED8" },
  "MIA": { name: "Michael Argenta", email: "michaelpargenta@gmail.com", slackId: "U0BR37FUJQH" },
  "MIC": { name: "Mitchel Corrado", email: "mitchelcorrado15@gmail.com", slackId: "U0BPS0PD7FY" },
  "MIN": { name: "Montgomery Inman", email: "montgomeryinman@gmail.com", slackId: "U0BQXH1BANR" },
  "MIP": { name: "Mike Phillips", email: "mlphillips42@yahoo.com", slackId: "U0BR39GSMMF" },
  "MIS": { name: "Michael Dean Shea", email: "michaelshea9247@gmail.com", slackId: "U0BPQBX3U05" },
  "MJN": { name: "Michael Johnson", email: "michaelpjohnson8@gmail.com", slackId: "U0BR38U35SM" },
  "MJO": { name: "Marcus Jones", email: "averyjones831@gmail.com", slackId: null },
  "MLE": { name: "Miles Leicht", email: "milesleicht@gmail.com", slackId: "U0BR1A0FW7L" },
  "MLJ": { name: "Milos Ljubic", email: "ljubic.milosljubic@gmail.com", slackId: "U0BPXL7M3SQ" },
  "MLT": { name: "Michael Lauritzen", email: "lauritzen_mike@yahoo.com", slackId: null },
  "MLU": { name: "Michael Ludwig", email: "stalbertchess@gmail.com", slackId: "U0BR1986GSW" },
  "MMD": { name: "Milhaley Docs", email: "misodocs01@gmail.com", slackId: null },
  "MMH": { name: "Michael Gregory McHugh", email: "mimch127@gmail.com", slackId: "U0BQL0EBA4F" },
  "MMI": { name: "Michael Monacelli", email: "m.monacelli990@gmail.com", slackId: "U0BPCJG830X" },
  "MMN": { name: "Marcus Montesion", email: "montesionm@gmail.com", slackId: "U0BPS0XUCBY" },
  "MOC": { name: "Matthew Ocampo", email: "matt.ocampo32@gmail.com", slackId: "U0BPTVBJ57U" },
  "MOV": { name: "Michael Overbeck", email: "michaelcoverbeck@gmail.com", slackId: "U0BQV4AHF2P" },
  "MPC": { name: "Michael Pierce", email: "michael_pierce@outlook.com", slackId: "U0BR1A70BNW" },
  "MPE": { name: "Mátyás Petrás", email: "matyaspetras@protonmail.ch", slackId: "U0BQV56ARRR" },
  "MPI": { name: "Matt Pike", email: "Capnwar055@gmail.com", slackId: null },
  "MPR": { name: "Mark Portillo", email: "markportillo1705@gmail.com", slackId: "U0BR51D69CL" },
  "MRU": { name: "Matthew Rubine", email: "matthewbrubine@gmail.com", slackId: "U0BQV3XV4SF" },
  "MSI": { name: "Mitchell Simons", email: "gx81mitch@gmail.com", slackId: "U0BQXJX1URK" },
  "MSL": { name: "Matthew Sullivan", email: "mattsully715@gmail.com", slackId: "U0BQXL28XE1" },
  "MSN": { name: "Mathias Snedker Hernandez", email: "Mathias.snedker@gmail.com", slackId: "U0BQXHH2UDT" },
  "MST": { name: "Milan Stefanovic", email: "milanstefanovic83@gmail.com", slackId: "U0BPS0TEJLE" },
  "MSW": { name: "Matthew Sawyer", email: "msawyer516@gmail.com", slackId: null },
  "MTD": { name: "Maggie Todd", email: "toddmj295@gmail.com", slackId: "U0BQKVAAZF1" },
  "MTS": { name: "Matthew Smith", email: "mgsmith1203@gmail.com", slackId: "U0BR19ZPH0S" },
  "MVD": { name: "Maverick Diaz", email: "maverick.diaz@tcu.edu", slackId: "U0BQXGW49DK" },
  "MVI": { name: "Marcelo Villa", email: "marcelovilla24@gmail.com", slackId: "U0BQV3N2J1H" },
  "MVO": { name: "Mitchell Volino", email: "mitchellvolino60@gmail.com", slackId: "U0BR51KDHQC" },
  "MWO": { name: "Miles Woo", email: "mileswoo3@gmail.com", slackId: "U0BR1AH67MG" },
  "MXB": { name: "Max Brooks", email: "15maxbrooks@gmail.com", slackId: null },
  "MZG": { name: "Michael Zheng", email: "michaelzheng119@gmail.com", slackId: null },
  "NAC": { name: "Nathan Chou", email: "nathanjchou@gmail.com", slackId: "U0BQZCDHRCN" },
  "NBA": { name: "Nicola Baggi", email: "baggi.nicola33@gmail.com", slackId: "U0BPXLC239S" },
  "NBX": { name: "Nino Bux", email: "beingasannino@gmail.com", slackId: "U0BPCJ386K1" },
  "NCH": { name: "Navin Chandradat", email: "navin.chandradat@gmail.com", slackId: "U0BR1860RGS" },
  "NCI": { name: "Nick Ciardo", email: "nickrc101@gmail.com", slackId: null },
  "NFR": { name: "Nick Friedrichson", email: "Nick.freddy.music@gmail.com", slackId: "U0BPCJL4QB1" },
  "NG": { name: "Nick Gangwer", email: "ngang94@gmail.com", slackId: null },
  "NGR": { name: "Nathan Greving", email: "njgreving@gmail.com", slackId: "U0BQZAN2T7Y" },
  "NHW": { name: "Niles Hawkins", email: "nilesbhawkins@gmail.com", slackId: "U0BR182TSM8" },
  "NIC": { name: "Nicolas Ciricola", email: "nicolas.ciricola@gmail.com", slackId: "U0BR51HAHD2" },
  "NIH": { name: "Nicholas Holt", email: "nichjholt@gmail.com", slackId: "U0BR19XQSF4" },
  "NIL": { name: "Nicholas Lee", email: "nicholaslee0319@gmail.com", slackId: "U0BR18ZARD0" },
  "NIW": { name: "Nicholas Wimsatt", email: "wimsatt24@gmail.com", slackId: "U0BQV430B8T" },
  "NKE": { name: "Nathan Keiper", email: "nate.keiper.sb@gmail.com", slackId: "U0BPCJQ0MGF" },
  "NKV": { name: "Nick Vandiver", email: "nickvandiver92@yahoo.com", slackId: "U0BQNA4J3H6" },
  "NOL": { name: "Nathan Olsen", email: "npolsen1@gmail.com", slackId: "U0BQZDK4QLW" },
  "NPE": { name: "Nicholas Peterson", email: "NPeterson1680@gmail.com", slackId: null },
  "NPZ": { name: "Nicholas Parzych", email: "nwparzyc@syr.edu", slackId: "U0BQXJAFDBP" },
  "NRM": { name: "Nicholas Ramundo", email: "nramundo@fordham.edu", slackId: "U0BR1AL91L2" },
  "NRN": { name: "Nick Raines", email: "nickwraines@gmail.com", slackId: "U0BQKVB0V6K" },
  "NRU": { name: "Nicholas Russo", email: "nickrusso4@gmail.com", slackId: "U0BPQBSMZ1T" },
  "NSC": { name: "Nicholas sciscente", email: "Nikki9_9@hotmail.com", slackId: "U0BRVM07HFA" },
  "NSN": { name: "Nicolas Sanchez", email: "nico611972@gmail.com", slackId: "U0BR3974XND" },
  "NTA": { name: "Norbert Táskai", email: "taskain@gmail.com", slackId: "U0BPMNB39UK" },
  "NTH": { name: "Nicolas Thomas", email: "nicolascthomas@aol.com", slackId: null },
  "NWR": { name: "Noah Wright", email: "noahw918@gmail.com", slackId: "U0BR51B7QSG" },
  "OAV": { name: "Orlando Acevedo", email: "Kingoa23@gmail.com", slackId: null },
  "OLB": { name: "Olivér Beke", email: "bekeoliver@gmail.com", slackId: "U0BQNASMDGQ" },
  "OLD": { name: "Owen Ludgin", email: "owenludgin4@gmail.com", slackId: null },
  "PCA": { name: "Paul Cassaro", email: "paul.pff.base@gmail.com", slackId: null },
  "PCS": { name: "Péter Csonka", email: "ptrcsonka@gmail.com", slackId: "U0BPXKQMJAG" },
  "PDU": { name: "Paul Duncan", email: "duncanp@bgsu.edu", slackId: null },
  "PJQ": { name: "Peter Quinn", email: "peterq88.pq@gmail.com", slackId: null },
  "PLA": { name: "Peter Larsen", email: "PeterLarsen098@gmail.com", slackId: "U0BQXH08J3X" },
  "PMG": { name: "Patrick McGrath", email: "pmcgrath1223@gmail.com", slackId: "U0BPCJU9ZK9" },
  "PMO": { name: "Peter Morrison", email: "pmorrison6592@gmail.com", slackId: null },
  "PNG": { name: "Paul Nguyen", email: "paulnguyen96@gmail.com", slackId: null },
  "PNV": { name: "Preston Neville", email: "prestonneville@yahoo.com", slackId: "U0BQXK8S13P" },
  "PPE": { name: "Payton Person", email: "paytonperson16@gmail.com", slackId: "U0BPS0NL8B0" },
  "PPR": { name: "Paul Parkinson", email: "pparkinson1313@gmail.com", slackId: "U0BPS15NVL6" },
  "PRL": { name: "Porter Lehmann", email: "pcstatistics22@gmail.com", slackId: "U0BPQC0D5E1" },
  "PSU": { name: "Preston Schumacher", email: "preston.schumacher@yahoo.com", slackId: "U0BPQBSDJ5B" },
  "PXP": { name: "Paxton Peterson", email: "peterpax@mail.gvsu.edu", slackId: "U0BR1AB59GA" },
  "PYJ": { name: "Peyton Janssen", email: "pgjanssen@aol.com", slackId: null },
  "QRE": { name: "Quincie Reed", email: "reedquincie@gmail.com", slackId: null },
  "QSK": { name: "Quinn Sakelaris", email: "qsak713@gmail.com", slackId: null },
  "RBN": { name: "Ronan Bennett", email: "bennettronan06@gmail.com", slackId: "U0BQKV06G07" },
  "RBR": { name: "Robert Russell", email: "Rgr5076@gmail.com", slackId: "U0BPCJBGEEB" },
  "RCA": { name: "Russell Campbell", email: "russcam@comcast.net", slackId: "U0BQV4QG2E7" },
  "RCJ": { name: "Reece Johnston", email: "r.johnston1213@gmail.com", slackId: "U0BPTVB38P4" },
  "RDO": { name: "Ryan Dowlen", email: "rdowlen10@gmail.com", slackId: "U0BQZA6UFT8" },
  "RDS": { name: "Ryan Desautels", email: "Rdes89@yahoo.com", slackId: null },
  "RDY": { name: "Ryan Doyle", email: "22rdoyle@gmail.com", slackId: "U0BRVM4403S" },
  "RFI": { name: "Ramesh Fisher", email: "rameshfisher@gmail.com", slackId: "U0BQXJ19ZEZ" },
  "RGL": { name: "Ryan Gillespie", email: "Gillespie.ryan91@gmail.com", slackId: null },
  "RIL": { name: "Ricardo Illescas", email: "rillescas8484@gmail.com", slackId: "U0BQZC6LW7Q" },
  "RKI": { name: "Ryan Kistemaker", email: "rkistemaker422@gmail.com", slackId: "U0BR37RVDHP" },
  "RKR": { name: "Robert Krajcovic", email: "robokrajcovic89@gmail.com", slackId: "U0BPCJ70XP1" },
  "RLA": { name: "Ryan Lauritzen", email: "Lauritzr@yahoo.com", slackId: null },
  "RMA": { name: "Richard Maher", email: "rlfxmm@gmail.com", slackId: "U0BQV1YABL3" },
  "RMN": { name: "Richard Mann", email: "richardandersonmann@gmail.com", slackId: "U0BR51RABGU" },
  "RNI": { name: "Ross Nicol", email: "rossnicol@protonmail.com", slackId: "U0BR39K7X5X" },
  "RSC": { name: "Robert Schwabe III", email: "traeschwabe@proton.me", slackId: "U0BR51GDFMJ" },
  "RSI": { name: "Reid Simmons", email: "reidlsimmons99@gmail.com", slackId: "U0BPXLBEJN8" },
  "RST": { name: "Reid Stratton", email: "Kstratton164@gmail.com", slackId: "U0BQXJFMNGM" },
  "RTH": { name: "Robert Scott Thomas", email: "rsthomas82@gmail.com", slackId: "U0BQKV6MSMD" },
  "RVI": { name: "Richard Vid", email: "v91richard@gmail.com", slackId: null },
  "RWH": { name: "Rebekah Kara White", email: "rwhite46376@gmail.com", slackId: "U0BPMN0TBPD" },
  "RWI": { name: "Ralph Williams", email: "rwilliams.b3@gmail.com", slackId: null },
  "RYA": { name: "Rhys Astrop", email: "rhysjastrop@gmail.com", slackId: "U0BPVTW5JG1" },
  "RYB": { name: "Robby Bernardin", email: "bernardinrobby@gmail.com", slackId: null },
  "RYC": { name: "Ryan Campbell", email: "ryan.campbell1@wilkes.edu", slackId: "U0BR50UT3M2" },
  "RYE": { name: "Ryan Engel", email: "ryan.engel20@gmail.com", slackId: "U0BR39JGUBB" },
  "RYF": { name: "Raymond Flis", email: "raymond.m.flis@gmail.com", slackId: "U0BR38AR6BB" },
  "RYG": { name: "Ryan Gill", email: "gillr11@icloud.com", slackId: "U0BQKV5UK2T" },
  "RYH": { name: "Ryan Hudson", email: "ryan.hudson2222@gmail.com", slackId: "U0BR51MREDA" },
  "RYJ": { name: "Ryan Jones", email: "ryanktjones@gmail.com", slackId: "U0BQV2ZM36X" },
  "RZA": { name: "Roel Zavals", email: "bolander2@hotmail.com", slackId: "U0BR38Y03ND" },
  "SAM": { name: "Sam Moldenhauer", email: "Sam.Moldenhauer@gmail.com", slackId: null },
  "SAP": { name: "Sam Purfeerst", email: "sampurf@gmail.com", slackId: null },
  "SBI": { name: "Simon Bissonnette", email: "simon.bissonnette@northmail.ca", slackId: null },
  "SBR": { name: "Steven Bruschi", email: "sjbruschi@yahoo.com", slackId: "U0BR5154N1J" },
  "SCL": { name: "Sam Cleve", email: "samvancleve12@gmail.com", slackId: null },
  "SCO": { name: "Shane Copley", email: "shanecopley24@gmail.com", slackId: "U0BPS19AB4N" },
  "SCY": { name: "Stephen Cassady", email: "stevecady4713@msn.com", slackId: "U0BQXH5MBGV" },
  "SEH": { name: "Sergio Leobardo Heredia JR", email: "sheredia8512@gmail.com", slackId: null },
  "SEL": { name: "Sammy Elomari", email: "elomarisammy@gmail.com", slackId: "U0BR38KV1U1" },
  "SGD": { name: "Sayom Ghosh-Dastidar", email: "sgd305@nyu.edu", slackId: "U0BR4V5G0JG" },
  "SHA": { name: "Sam Hays", email: "WichitaChiefSam@gmail.com", slackId: "U0BPTUU0VAN" },
  "SHB": { name: "Shawn Buick", email: "shawntb99@gmail.com", slackId: "U0BQV1MVAMR" },
  "SHP": { name: "Shawn Hrapunsky", email: "shawnhrapunsky@gmail.com", slackId: "U0BR1ACECKC" },
  "SHR": { name: "Shawn Reid", email: "Shawn.cjay.reid@gmail.com", slackId: "U0BR3A216JV" },
  "SKG": { name: "Shawn King Jr", email: "shawnking436@gmail.com", slackId: "U0BQZCA5L0N" },
  "SKO": { name: "Sean Kopper", email: "koppersean@gmail.com", slackId: null },
  "SLA": { name: "Scott David Laubacher", email: "Scottieboiiee9@gmail.com", slackId: null },
  "SME": { name: "Sam Meyerson", email: "sammeyerson16@gmail.com", slackId: "U0BR52MGYTW" },
  "SPI": { name: "Stephen Piff", email: "piffs52@gmail.com", slackId: "U0BPQBMT3FF" },
  "SPR": { name: "Sergio Alberto Preciado", email: "Spreciado917@gmail.com", slackId: "U0BPCJYAUAK" },
  "SRY": { name: "Stephen Raydo", email: "raydo88@gmail.com", slackId: "U0BQKV3TELF" },
  "SSC": { name: "Skyler Schroeder", email: "scoutskyler@outlook.com", slackId: "U0BR1AT3ARY" },
  "SVT": { name: "Sullivan Tomich", email: "Stomich18@gmail.com", slackId: "U0BQL0XHZKR" },
  "SW": { name: "Stuart Whitaker", email: "stuartwhitaker24@hotmail.co.uk", slackId: "U0BR1BB5K8S" },
  "SWL": { name: "Samuel Weilert", email: "weilers24@bonaventure.edu", slackId: "U0BR1AHJ5EW" },
  "SZG": { name: "Sebastien Zagak", email: "zagalseb@gmail.com", slackId: "U0BR1AQ3UFL" },
  "SZP": { name: "Szilárd Pozsonyi", email: "szilard.pozsonyi@gmail.com", slackId: "U0BPMN62F8T" },
  "SZS": { name: "Szabolcs Szeker", email: "szesza19950204@gmail.com", slackId: "U0BR396R92M" },
  "TAL": { name: "Taylor Liddicoat", email: "19taylor97@gmail.com", slackId: "U0BQXGRMMA9" },
  "TBL": { name: "Tyler Bolebruch", email: "tbolebruch9@gmail.com", slackId: "U0BRVKD6S8G" },
  "TCB": { name: "Tony Cabalar", email: "tcabalar@hawaii.edu", slackId: "U0BQV24LYRH" },
  "TDW": { name: "Theodore Williams", email: "cortwilliams5@gmail.com", slackId: "U0BQXKDT37X" },
  "TEI": { name: "Tyler Eisloeffel", email: "tylereisloeffel@gmail.com", slackId: "U0BPMNT58M9" },
  "TFC": { name: "Thomas Carr", email: "thomasfrankjcarr@gmail.com", slackId: "U0BQXJEJV4M" },
  "TFY": { name: "Travis Findley", email: "tt.findley@gmail.com", slackId: "U0BQN9TPB8Q" },
  "TGR": { name: "Thomas Gresco", email: "tjgresco20@gmail.com", slackId: "U0BQL0M7RJB" },
  "THD": { name: "Thomas Deans", email: "tommyydeans@icloud.com", slackId: "U0BR19VT36E" },
  "THF": { name: "Thomas Fletcher", email: "thomasfletcher2003@gmail.com", slackId: "U0BPTUXTRJ6" },
  "TIR": { name: "Timothy Richardson", email: "timothy.richardson2011@gmail.com", slackId: "U0BR19L7266" },
  "TIS": { name: "Timothy Sones", email: "TimothySones@gmail.com", slackId: "U0BQZC9EYSJ" },
  "TJV": { name: "T.J. Vernieri", email: "T.J.Vernieri@GMail.com", slackId: "U0BQV37ELRZ" },
  "TJW": { name: "TJ Wood", email: "tjwood0711@gmail.com", slackId: null },
  "TLV": { name: "Tyler Levonduskie", email: "tlevonduskie@gmail.com", slackId: "U0BR188RGH0" },
  "TNH": { name: "Tanner Hinds", email: "tannerhinds7@gmail.com", slackId: "U0BPTV1NTDG" },
  "TNI": { name: "Tyler Nicholson", email: "Tyler.nicholson00@gmail.com", slackId: "U0BQXJZ64N9" },
  "TPA": { name: "Thomas Patten", email: "vanpattent02@gmail.com", slackId: null },
  "TPO": { name: "Tamás Podluzsánszky", email: "pody87@gmail.com", slackId: "U0BPS1138CE" },
  "TRB": { name: "Tristan Brumund", email: "Trbrumund@gmail.com", slackId: null },
  "TSB": { name: "Tristan Santibanez", email: "tristan.santibanez@gmail.com", slackId: null },
  "TSC": { name: "Trenten J Scheidegger", email: "trentscheids@yahoo.com", slackId: null },
  "TSL": { name: "Tristan Sloat", email: "tristansloat@gmail.com", slackId: "U0BQKUT2CR5" },
  "TSN": { name: "Tigie Sankoh", email: "tigiesankoh2@gmail.com", slackId: null },
  "TSZ": { name: "Tamás Szoláry", email: "szolary.tamas@gmail.com", slackId: "U0BQL16B3JT" },
  "TT": { name: "Ted Thanasas", email: "tthanasas@gmail.com", slackId: null },
  "TVB": { name: "Trev Buehler", email: "trevbuehler@gmail.com", slackId: "U0BR39KF75X" },
  "TYA": { name: "Trey Almeida", email: "treybrevinalmeida8506@gmail.com", slackId: null },
  "TYC": { name: "Tyler Clausen", email: "tjclause2580@gmail.com", slackId: "U0BPCJAU4F9" },
  "TYM": { name: "Tyler Martin", email: "n01498111@unf.edu", slackId: "U0BR3A058BT" },
  "TYS": { name: "Ty Slater", email: "tlslater12@gmail.com", slackId: "U0BQL0YUDMM" },
  "TZE": { name: "Tiffany Zeigler", email: "tzeigle3@gmail.com", slackId: null },
  "VJV": { name: "Vijay Vemu", email: "vijay.vemu@yahoo.com", slackId: "U0BQZD5JY3Y" },
  "VMO": { name: "Vincent Moscarelli", email: "moscarvince@gmail.com", slackId: "U0BR19V1RNW" },
  "VST": { name: "Veselin Stoyanov", email: "vstoyanov88@gmail.com", slackId: "U0BQZBM3HPG" },
  "WBO": { name: "William Boyd", email: "willboyd32@gmail.com", slackId: "U0BPMNXCHLK" },
  "WGF": { name: "William Giffen", email: "wmgiffen04@gmail.com", slackId: "U0BQXKCLJKX" },
  "WIB": { name: "William Bos", email: "Wb3409@yahoo.com", slackId: "U0BQXHVCTBP" },
  "WJA": { name: "Wojciech Andrzejczk", email: "coachvoyt@gmail.com", slackId: "U0BR504AUUU" },
  "WK": { name: "Wade Kreider", email: "wadeekreider@gmail.com", slackId: "U0BR50P0DLL" },
  "WNO": { name: "William Noland", email: "taylor.noland@gmail.com", slackId: "U0BQXJWP2JH" },
  "YHL": { name: "Yuhui Li", email: "double2melon@gmail.com", slackId: "U0BQXK4SMPF" },
  "YKZ": { name: "Yunke Zhang", email: "zhangtony1313@gmail.com", slackId: null },
  "YVA": { name: "Yves Arriola", email: "yvesfranco9@gmail.com", slackId: "U0BRVMK2D5W" },
  "ZAH": { name: "Zach Hart", email: "zh253805@gmail.com", slackId: null },
  "ZAY": { name: "Zachary Yeager", email: "zachyeager18@yahoo.com", slackId: "U0BPVTH08GH" },
  "ZBO": { name: "Zachary Boisvert", email: "boisvertzack13@gmail.com", slackId: "U0BPQC49KRB" },
  "ZBS": { name: "Zoot Boschwitz", email: "zoot.boschwitz@gmail.com", slackId: "U0BRVKVU7K2" },
  "ZHU": { name: "Zach Hutchison", email: "zach.s.hutchison@gmail.com", slackId: "U0BR50ECC7N" },
  "ZKU": { name: "Zsombor Kulcsar", email: "zsotyu@gmail.com", slackId: "U0BPQB93F45" },
  "ZLA": { name: "Zachary Lancaster", email: "zjlancaster@gmail.com", slackId: "U0BR50NJ0A0" },
  "ZNG": { name: "Zach Nguyen", email: "masteroflightning0@gmail.com", slackId: "U0BPMNJFVBM" },
  "ZOD": { name: "Zackery Odom", email: "odomzack@yahoo.com", slackId: null },
  "ZSH": { name: "Zsolt Herczeg", email: "herczeg.zsolt52@gmail.com", slackId: "U0BR50Q69PE" },
  "ZST": { name: "Zsombor Balázs Török", email: "t.zsobi98@gmail.com", slackId: "U0BQXJ7F4RK" },
  "ZSZ": { name: "Zoltan Szovics", email: "zoliszovics@gmail.com", slackId: "U0BPVTZFNHX" },
  "ZTI": { name: "Zaine Tischendorf", email: "zwtischendorf@gmail.com", slackId: null },
  "ZTM": { name: "Zachary Temenak", email: "zeescottish@gmail.com", slackId: null },
  "ZWD": { name: "Ngoc Duy Anh (Zwee) Dao", email: "155622d@acadiau.ca", slackId: "U0BPVTRDPLZ" },
  "ZYW": { name: "Zachary Waite", email: "zwaite@umass.edu", slackId: "U0BQZD55MB8" },
};

async function getSlackUserByInitials(initials) {
  try {
    const upperInitials = initials.toUpperCase();
    const fullName = INITIALS_TO_NAME[upperInitials];

    if (fullName) {
      // Generate email from initials: first letter of first name + last name + @teamworks.com
      // e.g., MT (Matthew Tichenor) -> mtichenor@teamworks.com
      // Exceptions: 
      //   RMS (Ryan Smith) -> ryan.smith@teamworks.com
      //   JGU (Jake Gudoian) -> rgudoian@teamworks.com
      const nameParts = fullName.split(' ');
      if (nameParts.length < 2) {
        console.log(`Could not parse name for ${initials}: "${fullName}"`);
        return null;
      }

      let email;
      if (upperInitials === 'RMS') {
        // Special case for Ryan Smith
        email = 'ryan.smith@teamworks.com';
      } else if (upperInitials === 'JGU') {
        // Special case for Jake Gudoian
        email = 'rgudoian@teamworks.com';
      } else {
        email = `${nameParts[0][0]}${nameParts[1]}@teamworks.com`.toLowerCase();
      }

      try {
        const response = await axios.get(
          'https://slack.com/api/users.lookupByEmail',
          {
            params: { email },
            headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
          }
        );

        if (response.data.ok) {
          console.log(`✅ Found ${initials} (${fullName}) via email: ${email} → ${response.data.user.id}`);
          return response.data.user.id;
        } else {
          console.log(`❌ ${initials} (${fullName}) - email ${email} not found: ${response.data.error}`);
          return null;
        }
      } catch (error) {
        console.error(`Error looking up ${email}:`, error.message);
        return null;
      }
    }

    // Not in the legacy map — check the expanded roster (NEW_STAFF) added from
    // the 2026 PFF Schedule - Staff List CSV. These use actual emails from the
    // roster (not a formula), since PT staff mostly use personal email addresses.
    const staffInfo = NEW_STAFF[upperInitials];
    if (staffInfo) {
      // Prefer the Slack ID directly from the roster when we have it — skips
      // the email lookup (and any rate-limit risk) entirely.
      if (staffInfo.slackId) {
        console.log(`✅ Found ${initials} (${staffInfo.name}) via known Slack ID: ${staffInfo.slackId}`);
        return staffInfo.slackId;
      }

      if (staffInfo.email) {
        try {
          const response = await axios.get(
            'https://slack.com/api/users.lookupByEmail',
            {
              params: { email: staffInfo.email },
              headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
            }
          );

          if (response.data.ok) {
            console.log(`✅ Found ${initials} (${staffInfo.name}) via email: ${staffInfo.email} → ${response.data.user.id}`);
            return response.data.user.id;
          } else {
            console.log(`❌ ${initials} (${staffInfo.name}) - email ${staffInfo.email} not found: ${response.data.error}`);
            return null;
          }
        } catch (error) {
          console.error(`Error looking up ${staffInfo.email}:`, error.message);
          return null;
        }
      }

      console.log(`No email or Slack ID on file for ${initials} (${staffInfo.name})`);
      return null;
    }

    console.log(`No name mapping for: ${initials}`);
    return null;
  } catch (error) {
    console.error('Error in getSlackUserByInitials:', error.message);
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

    const messageText = `Hey, it's Zoltan. Just a gentle reminder that you have ${breakdown} today. Are you OK to do that by the deadline? 👀`;

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
    console.log(`Logging acknowledgment: ${initials} - ${team}`);
    
    // Create auth with service account
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountCredentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheetsApi = google.sheets({ version: 'v4', auth });

    const result = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: TRACKING_SHEET_ID,
      range: 'Sheet1!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[new Date().toISOString().split('T')[0], initials, team, 'Acknowledged', new Date().toISOString(), 'Button click']]
      }
    });
    
    console.log(`✅ Acknowledgment logged for ${initials} - ${team}`);
    return result;
  } catch (error) {
    console.error('Error logging to tracking sheet:', error.message);
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

app.post('/slack/actions', async (req, res) => {
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
          
          // Update the message to show "Confirmed" button
          const confirmedBlocks = [
            payload.message.blocks[0],  // Keep the original text block
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: '✅ Confirmed', emoji: true },
                  value: initials,
                  disabled: true,
                  action_id: `confirmed_${initials}_${team}_${date}`
                }
              ]
            }
          ];
          
          // Update the message using chat.update (works indefinitely, unlike response_url)
          try {
            // Create clean blocks without the extra metadata Slack adds
            const cleanBlocks = [
              {
                type: 'section',
                text: { 
                  type: 'mrkdwn', 
                  text: payload.message.blocks[0].text.text 
                }
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: '✅ Confirmed', emoji: true },
                    value: initials,
                    action_id: `already_confirmed_${initials}_${team}_${date}`
                    // No style = gray button, no disabled = valid block
                  }
                ]
              }
            ];
            
            console.log(`Attempting to update message:`);
            console.log(`  Channel: ${payload.channel.id}`);
            console.log(`  Timestamp: ${payload.message.ts}`);
            console.log(`  Blocks: ${JSON.stringify(cleanBlocks)}`);
            
            const updateResponse = await axios.post(
              'https://slack.com/api/chat.update',
              {
                channel: payload.channel.id,
                ts: payload.message.ts,
                blocks: cleanBlocks
              },
              { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
            );
            
            console.log(`Response status: ${updateResponse.status}`);
            console.log(`Response data:`, updateResponse.data);
            
            if (updateResponse.data.ok) {
              console.log(`✅ Message updated successfully for ${initials}`);
            } else {
              console.error(`❌ Failed to update message: ${updateResponse.data.error}`);
            }
          } catch (err) {
            console.error(`Error updating message for ${initials}:`, err.message);
            console.error(`Full error:`, err.response?.data);
          }
          
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

// Schedule for 5am ET daily
cron.schedule('0 5 * * *', runReminderCheck, {
  timezone: 'America/New_York'
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Reminder check scheduled for 5am ET daily');
});
