import fetch from 'node-fetch';

// PhilSMS API token
const PHILSMS_API_TOKEN = '3186|RQCCqdWxPG9SuGOrqPvBdDoFIfeOmw0WqVDev9Vg';

// Replace with your own Philippine number in international format
const TO_NUMBER = '639954192956'; // 09XXXXXXXXX → 639XXXXXXXXX
const MESSAGE = 'Test SMS from Node server!';
const SENDER_ID = 'PhilSMS'; // Alphanumeric, max 11 chars

async function sendTestSMS() {
  try {
    const response = await fetch('https://app.philsms.com/api/v3/sms/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PHILSMS_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        recipient: TO_NUMBER,
        sender_id: SENDER_ID,
        type: 'plain',
        message: MESSAGE
      })
    });

    const text = await response.text();

    try {
      const result = JSON.parse(text);
      console.log('API Response:', result);

      if (result.status === 'success') {
        console.log('✅ SMS sent! Trial credits are active.');
      } else {
        console.log('❌ SMS failed.');
        console.log('Error details:', result);
      }
    } catch {
      console.log('❌ Could not parse JSON. Response body:');
      console.log(text);
    }
  } catch (error) {
    console.error('Error sending SMS:', error);
  }
}

sendTestSMS();
