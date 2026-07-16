import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const logDir = path.join(process.cwd(), 'logs');

// Helper to format timestamps to Ecuador timezone (GMT-5)
const getEcuadorTimestamp = () => {
  const now = new Date();
  const ecDate = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  return ecDate.toISOString().replace('T', ' ').slice(0, 19);
};

// Custom format combining timestamp, label category, log level, and message
const customFormat = winston.format.printf(({ level, message, label }) => {
  const timestamp = getEcuadorTimestamp();
  const labelStr = label ? ` [${label}]` : '';
  return `[${timestamp}]${labelStr} ${level.toUpperCase()}: ${message}`;
});

// Helper to create a robust logger for a specific category/service
const createCategoryLogger = (label: string) => {
  return winston.createLogger({
    format: winston.format.combine(
      winston.format.label({ label }),
      customFormat
    ),
    transports: [
      // Output to standard console (PM2 logs)
      new winston.transports.Console(),
      // Output to daily rotating file with 14 days retention
      new DailyRotateFile({
        dirname: logDir,
        filename: `${label.toLowerCase()}-%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        maxFiles: '14d',
        level: 'info'
      })
    ]
  });
};

export const systemLogger = createCategoryLogger('System');
export const celecLogger = createCategoryLogger('CELEC');
export const cenaceLogger = createCategoryLogger('CENACE');
export const dbLogger = createCategoryLogger('Database');
export const xLogger = createCategoryLogger('X');
