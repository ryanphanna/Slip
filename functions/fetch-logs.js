const { Logging } = require('@google-cloud/logging');

async function fetchLogs() {
  try {
    const logging = new Logging({ projectId: 'slip-c742b' });
    // Fetch recent logs for the Cloud Run service "sms"
    const [entries] = await logging.getEntries({
      filter: 'resource.type="cloud_run_revision" AND resource.labels.service_name="sms" AND severity>="ERROR"',
      pageSize: 5,
      orderBy: 'timestamp desc'
    });

    console.log("Found", entries.length, "error logs:");
    entries.forEach(entry => {
      console.log(`[${entry.metadata.timestamp}] ${entry.metadata.severity}:`);
      if (entry.data && entry.data.message) {
        console.log(entry.data.message);
      } else {
        console.log(entry.data);
      }
    });
  } catch (e) {
    console.error("Failed to fetch logs:", e);
  }
}
fetchLogs();
