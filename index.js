const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
require('dotenv').config(); // Load environment variables from .env
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// AWS credentials and configuration from .env
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const printers = [
  { name: 'Office Printer', ip: '192.168.3.36', port: 9100 },
  { name: 'Warehouse Printer', ip: '172.16.87.3', port: 9100 },
];

let mainWindow;
let printedFiles = new Set();

function logToUI(message) {
  if (mainWindow) {
    mainWindow.webContents.send('status-update', `[${new Date().toLocaleTimeString()}] ${message}`);
  }
  console.log(message);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  setInterval(() => {
    pollS3ForPrintJobs();
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function pollS3ForPrintJobs() {
  logToUI('Polling S3 for print jobs...');
  try {
    const listCommand = new ListObjectsV2Command({ Bucket: AWS_S3_BUCKET });
    const data = await s3Client.send(listCommand);

    if (!data.Contents) {
      logToUI('No files found in S3 bucket.');
      return;
    }

    const newFiles = data.Contents.filter(obj => obj.Key.endsWith('.ps') && !printedFiles.has(obj.Key));

    for (const fileToPrint of newFiles) {
      logToUI(`New job found: ${fileToPrint.Key}`);

      mainWindow.webContents.send('new-print-job', fileToPrint.Key);

      logToUI(`Downloading ${fileToPrint.Key} from S3...`);
      const getObjectCommand = new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: fileToPrint.Key });
      const psObject = await s3Client.send(getObjectCommand);

      const chunks = [];
      for await (const chunk of psObject.Body) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);

      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

      const safeFileName = fileToPrint.Key.replace(/[\/\\]/g, '_');
      const psPath = path.join(tempDir, safeFileName);
      fs.writeFileSync(psPath, fileBuffer);

      logToUI(`Saved ${safeFileName} locally.`);

      mainWindow.webContents.send('print-ready', { key: fileToPrint.Key, path: psPath });

      printedFiles.add(fileToPrint.Key);
    }

    if (newFiles.length === 0) {
      logToUI('No new PS files found in S3 bucket.');
    }
  } catch (err) {
    logToUI(`S3 polling error: ${err.message}`);
  }
}

ipcMain.on('print-file', async (event, { filePath, printerName, s3Key }) => {
  logToUI(`Print request: ${filePath} → ${printerName}`);

  const printer = printers.find(p => p.name === printerName);
  if (!printer) {
    logToUI(`Printer "${printerName}" not found.`);
    mainWindow.webContents.send('refresh-ui'); 
    return;
  }

  try {
    logToUI(`Sending file to ${printer.name} (${printer.ip}:${printer.port})...`);
    await sendPsToPrinter(filePath, printer.ip, printer.port);

    logToUI(`File sent to printer successfully.`);

    fs.unlink(filePath, (err) => {
      if (err) logToUI(`Failed to delete local file: ${err.message}`);
      else logToUI(`Deleted local file: ${filePath}`);
    });

    if (s3Key) {
      try {
        const deleteCommand = new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: s3Key });
        await s3Client.send(deleteCommand);
        logToUI(`Deleted S3 object: ${s3Key}`);
        printedFiles.delete(s3Key);
      } catch (s3Err) {
        logToUI(`Failed to delete S3 object: ${s3Err.message}`);
      }
    }

    logToUI('✅ Print successful and cleaned up.');
  } catch (err) {
    logToUI(`❌ Printing failed: ${err.message}`);
  } finally {
    mainWindow.webContents.send('refresh-ui');
  }
});

function sendPsToPrinter(psPath, printerIP, printerPort) {
  return new Promise((resolve, reject) => {
    let data;
    try {
      data = fs.readFileSync(psPath);
    } catch (err) {
      return reject(new Error(`Failed to read PS file: ${err.message}`));
    }

    const client = new net.Socket();
    client.setTimeout(30000);

    client.connect(printerPort, printerIP, () => {
      logToUI(`Connected to printer at ${printerIP}:${printerPort}`);
      client.write(data, () => {
        logToUI('Data sent to printer.');
        client.end();
      });
    });

    client.on('close', () => {
      logToUI('Printer connection closed.');
      resolve();
    });

    client.on('error', (err) => {
      reject(new Error(`Printer connection error: ${err.message}`));
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Printer connection timeout.'));
    });
  });
}
