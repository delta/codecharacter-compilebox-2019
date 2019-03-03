const express = require('express');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const childProcess = require('child_process');
const zlib = require('zlib');
const fs = require('fs');
const util = require('util');
const randomstring = require('randomstring');

// Init Config Constants
const secretKey = require('./config.js').configKey;
const appPort = require('./config.js').port;

// Init App
const app = express();
app.use(logger('dev'));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb' }));
app.use(cookieParser());

// Constants
const COMPILE_DIRECTORY_BASE = 'compileboxes';
const EXECUTE_DIRECTORY_BASE = 'executeboxes';
const COMPILE_DIRECTORY_PREFIX = `${COMPILE_DIRECTORY_BASE}/compile_`;
const EXECUTE_DIRECTORY_PREFIX = `${EXECUTE_DIRECTORY_BASE}/execute_`;
const PLAYER_CODE_DIRECTORY = '/root/codecharacter/src/player_code/src';
const COMPILER_IMAGE = 'deltanitt/codecharacter-compiler-2019:latest';
const RUNNER_IMAGE = 'deltanitt/codecharacter-runner-2019:latest';

// Helper function to strip ANSI characters from console output
const stripAnsi = input => input.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Maintains a count of how many requests are currently being served
// Note that this is obviously volatile and vanishes when the process
// is stopped. It is NOT persisted
//
// Docker containers that had been spawned when the app crashed will
// either die or live out their life and eventually stop.
let requestCount = 0;

// The maximum number of concurrent requests to handle
const maxRequests = 2;

// Helper function to parse results from the result line output of the simulator
const parseResultsFromString = (resultsString) => {

  const resultsItems = resultsString.split(' ').map(item => item.trim());

  // Destructure results string
  const [
    key,
    winner,
    winType,
    interestingness,
    player1Score,
    player1Status,
    player2Score,
    player2Status,
  ] = resultsItems;

  return {
    key,
    winner,
    winType,
    interestingness,
    scores: [
      {
        score: parseInt(player1Score),
        status: player1Status,
      },
      {
        score: parseInt(player2Score),
        status: player2Status,
      },
    ],
  };
};

// Promisified async versions of standard functions
const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const statFileAsync = util.promisify(fs.stat);
const execChildProcessAsync = util.promisify(childProcess.exec);

// Helper method to end the game and decrement the request count
const endGame = async (transactionDirectory) => {
  requestCount -= 1;
  if ((await statFileAsync(`${transactionDirectory}`)).isDirectory()) {
    await execChildProcessAsync(`rm -rf ${transactionDirectory}`);
  }
};

// Compile Route
app.post('/compile', async (req, res) => {
  // If we're handling too many requests, stop
  if (requestCount === maxRequests) {
    return res.json({
      success: false,
      error: 'Box is busy... Please wait!',
      errorType: 'BOX_BUSY',
    });
  }

  // Increment the requestCount
  requestCount += 1;

  // Read input parameters
  const { code, secretString } = req.body;

  // Generate a new directory name for this transaction
  const compileDirectory = COMPILE_DIRECTORY_PREFIX + randomstring.generate();

  // Check compilebox security key
  if (secretString !== secretKey) {
    await endGame(compileDirectory);
    return res.json({
      success: false,
      error: 'Unauthorized!',
      errorType: 'UNAUTHORIZED',
    });
  }

  try {
    // Create new subdirectory for this transaction
    await execChildProcessAsync(`
      mkdir -p ${compileDirectory}/dlls && \
      mkdir -p ${compileDirectory}/source`);

    // Write the player code into a file to ready it for compilation
    await writeFileAsync(`${compileDirectory}/source/player_code.cpp`, code);

    // Launch the compile container, passing the directories as params
    // Once compile is done, the output libs are mapped back into the libs directory
    const { stdout, stderr } = await execChildProcessAsync(`
      docker run \
      -v $(pwd)/${compileDirectory}/dlls:/root/output_libs \
      -v $(pwd)/${compileDirectory}/source:${PLAYER_CODE_DIRECTORY} \
      -t ${COMPILER_IMAGE}`);

    // Strip ANSI special color characters in compiler output
    const strippedStdout = stripAnsi(stdout);
    const strippedStderr = stripAnsi(stderr);

    // Log outputs for visibility
    console.log(strippedStdout, strippedStderr);

    // If there was an error in compilation
    if (strippedStdout.toLowerCase().indexOf('error:') !== -1
     || strippedStdout.toLowerCase().indexOf('errors') !== -1) {
      // Strip ANSI special color characters in compiler output
      const strippedStdout = stripAnsi(stdout);
      await endGame(compileDirectory);
      return res.json({
        success: false,
        error: strippedStdout,
        errorType: 'COMPILE_ERROR',
      });
    }

    // Read the output DLLs
    const dll1 = await readFileAsync(`${compileDirectory}/dlls/libplayer_1_code.so`);
    const dll2 = await readFileAsync(`${compileDirectory}/dlls/libplayer_2_code.so`);

    // Return response
    await endGame(compileDirectory);
    return res.json({
      success: true,
      dll1,
      dll2,
    });

  // Catch all
  } catch (e) {
    await endGame(compileDirectory);
    console.error(e);
    return e;
  }
});

// Execute Route
app.post('/execute', async (req, res) => {
  // If we're handling too many requests, stop
  if (requestCount === maxRequests) {
    return res.json({
      success: false,
      error: 'Box is busy... Please wait!',
    });
  }

  // Increment the requestCount
  requestCount += 1;

  // Generate a new directory name for this transaction
  const executeDirectory = EXECUTE_DIRECTORY_PREFIX + randomstring.generate();

  // Read input parameters
  const { map, secretString } = req.body;
  let { dll1, dll2 } = req.body;

  // Check compilebox security key
  if (secretString !== secretKey) {
    await endGame(executeDirectory);
    return res.json({
      success: false,
      message: 'Unauthorized!',
      errorType: 'BOX_BUSY',
    });
  }

  // Read DLL data into Buffer objects
  dll1 = new Buffer.from(req.body.dll1);
  dll2 = new Buffer.from(req.body.dll2);

  // App security key
  const key = randomstring.generate();

  try {
    // Remove anything previously contained in the directory and create new subdirectories
    await execChildProcessAsync(`
      mkdir -p ${executeDirectory}/dlls && \
      mkdir -p ${executeDirectory}/output_log`);

    // Write the player DLLs
    await writeFileAsync(`${__dirname}/${executeDirectory}/dlls/libplayer_1_code.so`, dll1);
    await writeFileAsync(`${__dirname}/${executeDirectory}/dlls/libplayer_2_code.so`, dll2);

    // Write the map and key files
    await writeFileAsync(`${__dirname}/${executeDirectory}/dlls/map.txt`, map);
    await writeFileAsync(`${__dirname}/${executeDirectory}/dlls/key.txt`, key);

    let stdout;
    let stderr;

    try {
    // Launch the execute container, and pass output directories as parameters
      ({ stdout, stderr } = await execChildProcessAsync(`
        docker run  --name codecharacter-runner-${key} \
        -v $(pwd)/${executeDirectory}/dlls:/root/input_libs \
        -v $(pwd)/${executeDirectory}/output_log:/root/output_log \
        -t ${RUNNER_IMAGE}`, {
        timeout: 30000,
      }));
    } catch (err) {
      execChildProcessAsync(`docker kill codecharacter-runner-${key}`);
      stderr = '';
      stdout = `${key} TIE TIMEOUT 0 0 TIMEOUT 0 TIMEOUT\n `;
    }

    // Log output for visibility
    console.log(stdout, stderr);

    // If some other runtime error occured
    if (stderr) {
      await endGame(executeDirectory);
      return res.json({
        success: false,
        error: stripAnsi(stderr),
        errorType: 'UNKNOWN_EXECUTE_ERROR',
      });
    }

    // Get the game scores from the end of stdout
    const stdoutArray = stdout.split('\n');
    const resultsString = stdoutArray[stdoutArray.length - 2];

    const results = parseResultsFromString(resultsString);

    // Ensure the security key matches
    if (results.key !== key) {
      await endGame(executeDirectory);
      return res.json({
        success: false,
        error: 'Security key mismatch! Possibly result tampering by player.',
        errorType: 'KEY_MISMATCH',
      });
    }

    // If we've gotten this far, the security keys match. Remove it from results
    delete results.key;

    // Else, we write the game log to file, and compress
    const log = await readFileAsync(`${executeDirectory}/output_log/game.log`);

    // Write player debug logs to file, and compress
    const player1Log = await readFileAsync(`${executeDirectory}/output_log/player_1.dlog`);
    const player2Log = await readFileAsync(`${executeDirectory}/output_log/player_2.dlog`);
    const player1LogCompressed = JSON.stringify(zlib.gzipSync(player1Log));
    const player2LogCompressed = JSON.stringify(zlib.gzipSync(player2Log));
    const logCompressed = JSON.stringify(zlib.gzipSync(log));

    // Return response with logs and results
    await endGame(executeDirectory);
    return res.json({
      success: true,
      log: logCompressed,
      results,
      player1LogCompressed,
      player2LogCompressed,
    });

  // Catch all
  } catch (e) {
    await endGame(executeDirectory);
    console.error(e);
    return e;
  }
});

// 404 Catch-all
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// Start server
app.listen(appPort);
console.log('Server Ready...');
