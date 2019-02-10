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
const COMPILE_DIRECTORY = 'compilebox_transaction';
const EXECUTE_DIRECTORY = 'executebox_transaction';
const PLAYER_CODE_DIRECTORY = '/root/codecharacter/src/player_code/src';
const COMPILER_IMAGE = 'deltanitt/codecharacter-compiler-2019:latest';
const RUNNER_IMAGE = 'deltanitt/codecharacter-runner-2019:latest';

// Helper function to strip ANSI characters from console output
const stripAnsi = input => input.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Helper function to parse results from the result line output of the simulator
const parseResultsFromString = (resultsString) => {
  const resultsItems = resultsString.split(' ');

  // Destructure results string
  const [key, player1Score, player1Status, player2Score, player2Status] = resultsItems;

  return {
    key,
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

// Compile Route
app.post('/compile', async (req, res) => {
  const { code, secretString } = req.body;

  // Check compilebox security key
  if (secretString !== secretKey) {
    return res.json({
      success: false,
      message: 'Unauthorized!',
    });
  }

  try {
    const directoryCheckStat = await statFileAsync(`./${COMPILE_DIRECTORY}`);

    // If it's not a valid directory, quit
    if (!directoryCheckStat.isDirectory()) {
      console.log(`Please create the ${COMPILE_DIRECTORY} directory. Aborting...`);
      return res.json({
        success: false,
        error: 'Internal Server Error',
      });
    }

    // Remove anything previously contained in the directory and create new subdirectories
    await execChildProcessAsync(`
      rm -rf ./${COMPILE_DIRECTORY} && \
      mkdir -p ${COMPILE_DIRECTORY}/dlls && \
      mkdir -p ${COMPILE_DIRECTORY}/source`);

    // Write the player code into a file to ready it for compilation
    await writeFileAsync(`./${COMPILE_DIRECTORY}/source/player_code.cpp`, code);

    // Launch the compile container, passing the directories as params
    // Once compile is done, the output libs are mapped back into the libs directory
    const { stdout, stderr } = await execChildProcessAsync(`
      docker run \
      -v $(pwd)/${COMPILE_DIRECTORY}/dlls:/root/output_libs \
      -v $(pwd)/${COMPILE_DIRECTORY}/source:${PLAYER_CODE_DIRECTORY} \
      -t ${COMPILER_IMAGE}`);

    // Log outputs for visibility
    console.log(stdout, stderr);

    // If there was an error in compilation
    if (stdout.toLowerCase().indexOf('error:') !== -1) {
      // Strip ANSI special color characters in compiler output
      const strippedStdout = stripAnsi(stdout);
      return res.json({
        success: false,
        error: strippedStdout,
      });
    }

    // Read the output DLLs
    const dll1 = await readFileAsync(`./${COMPILE_DIRECTORY}/dlls/libplayer_1_code.so`);
    const dll2 = await readFileAsync(`./${COMPILE_DIRECTORY}/dlls/libplayer_2_code.so`);

    // Return response
    return res.json({
      success: true,
      dll1,
      dll2,
    });

  // Catch all
  } catch (e) {
    console.error(e);
    return e;
  }
});

// Execute Route
app.post('/execute', async (req, res) => {
  const { map, secretString } = req.body;
  let { dll1, dll2 } = req.body;

  // Check compilebox security key
  if (secretString !== secretKey) {
    return res.json({
      success: false,
      message: 'Unauthorized!',
    });
  }

  // Read DLL data into Buffer objects
  dll1 = new Buffer.from(req.body.dll1);
  dll2 = new Buffer.from(req.body.dll2);

  // App security key
  const key = randomstring.generate();

  try {
    // Check if the container directory exists
    const directoryCheckStat = await statFileAsync(`./${EXECUTE_DIRECTORY}`);

    // If it's not a valid directory, quit
    if (!directoryCheckStat.isDirectory()) {
      console.log(`Please create the ${EXECUTE_DIRECTORY} directory. Aborting...`);
      return res.json({
        success: false,
        error: 'Internal Server Error',
      });
    }

    // Remove anything previously contained in the directory and create new subdirectories
    await execChildProcessAsync(`
      rm -rf ./${EXECUTE_DIRECTORY} && \
      mkdir -p ${EXECUTE_DIRECTORY}/dlls && \
      mkdir -p ${EXECUTE_DIRECTORY}/output_log`);

    // Write the player DLLs
    await writeFileAsync(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/libplayer_1_code.so`, dll1);
    await writeFileAsync(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/libplayer_2_code.so`, dll2);

    // Write the map and key files
    await writeFileAsync(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/map.txt`, map);
    await writeFileAsync(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/key.txt`, key);

    // Launch the execute container, and pass output directories as parameters
    const { stdout, stderr } = await execChildProcessAsync(`
      docker run \
      -v $(pwd)/${EXECUTE_DIRECTORY}/dlls:/root/input_libs \
      -v $(pwd)/${EXECUTE_DIRECTORY}/output_log:/root/output_log \
      -t ${RUNNER_IMAGE}`);

    // Log output for visibility
    console.log(stdout, stderr);

    // If there was a visible error during runtime
    if (stdout.toLowerCase().indexOf('error') !== -1) {
      return res.json({
        success: false,
        error: stripAnsi(stdout),
      });
    }

    // If some other runtime error occured
    if (stderr) {
      return res.json({
        success: false,
        error: stripAnsi(stderr),
      });
    }

    // Get the game scores from the end of stdout
    const stdoutArray = stdout.split('\n');
    const resultsString = stdoutArray[stdoutArray.length - 2];

    const results = parseResultsFromString(resultsString);

    // Ensure the security key matches
    if (results.key !== key) {
      return res.json({
        success: false,
        error: 'Security key mismatch! Possibly result tampering by player.',
      });
    }

    // If we've gotten this far, the security keys match. Remove it from results
    delete results.key;

    // If the game ended with an UNDEFINED status, return blank
    if (results.indexOf('UNDEFINED') !== -1) {
      return res.json({
        success: true,
        log: '',
        results,
        player1LogCompressed: '',
        player2LogCompressed: '',
      });
    }

    // Else, we write the game log to file, and compress
    const log = await readFileAsync(`${EXECUTE_DIRECTORY}/output_log/game.log`);
    const logCompressed = zlib.gzipSync(log);

    // Write player debug logs to file, and compress
    const player1Log = await readFileAsync(`./${EXECUTE_DIRECTORY}/output_log/player_1.dlog`);
    const player2Log = await readFileAsync(`./${EXECUTE_DIRECTORY}/output_log/player_2.dlog`);
    const player1LogCompressed = zlib.gzipSync(player1Log);
    const player2LogCompressed = zlib.gzipSync(player2Log);

    // Return response with logs and results
    res.json({
      success: true,
      log: logCompressed,
      results,
      player1LogCompressed,
      player2LogCompressed,
    });

  // Catch all
  } catch (e) {
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
