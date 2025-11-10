const https = require('https');

function makeRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const SWARMNODE_KEY = process.env.SWARMNODE_API_KEY;
    const SWARMNODE_BASE = process.env.SWARMNODE_BASE || 'https://api.swarmnode.ai';
    const INGEST_AGENT_ID = process.env.INGEST_AGENT_ID;

    if (!SWARMNODE_KEY || !INGEST_AGENT_ID) {
      return res.status(500).json({ 
        error: 'Missing configuration',
        details: 'Add SWARMNODE_API_KEY and INGEST_AGENT_ID in Vercel environment variables'
      });
    }

    let csvText = '';
    if (typeof req.body === 'string') {
      try {
        csvText = JSON.parse(req.body).csv || req.body;
      } catch {
        csvText = req.body;
      }
    } else if (req.body) {
      csvText = req.body.csv || req.body.csvText || JSON.stringify(req.body);
    }

    if (!csvText || csvText.length < 50) {
      return res.status(400).json({ 
        error: 'Invalid CSV data',
        details: 'CSV text is too short or empty'
      });
    }

    const payload = {
      csv_text: csvText,
      slate_date: new Date().toISOString().split('T')[0],
      slate_type: 'Classic'
    };

    const postData = JSON.stringify({
      agent_id: INGEST_AGENT_ID,
      payload: payload
    });

    const response = await makeRequest(
      `${SWARMNODE_BASE}/v1/agent-executor-jobs/create/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SWARMNODE_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      },
      postData
    );

    let result;
    try {
      result = JSON.parse(response.body);
    } catch {
      result = { raw: response.body };
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return res.status(200).json({
        success: true,
        message: 'CSV processed! Your DFS optimizer pipeline is running.',
        job_id: result.job_id || result.id,
        details: {
          csv_length: csvText.length,
          flow: 'INGEST → SIGNALS → PROJECTIONS → OPTIMIZER'
        },
        next_steps: [
          'Check SwarmNode dashboard for progress',
          'Results available in 30-90 seconds',
          'Look for OPTIMIZER agent output'
        ]
      });
    } else {
      return res.status(response.statusCode || 500).json({
        error: 'SwarmNode API error',
        details: result
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      error: 'Server error',
      message: error.message
    });
  }
};
