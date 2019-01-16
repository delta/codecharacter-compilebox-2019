const express = require('express');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const childProcess = require('child_process');
const zlib = require('zlib');
const fs = require('fs');

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
const COMPILER_IMAGE = 'deltanitt/codecharacter-compiler:latest';
const RUNNER_IMAGE = 'deltanitt/codecharacter-runner:latest';

// Helper function to strip ANSI characters from console output
const stripAnsi = input => input.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Compile Route
app.post('/compile', (req, res) => {
  const { code, secretString } = req.body;

  if (secretString !== secretKey) {
    return res.json({
      success: false,
      message: 'Unauthorized!',
    });
  }

  try {
    // Check if the container directory exists
    fs.stat(`./${COMPILE_DIRECTORY}`, (directoryCheckError, stats) => {
      if (directoryCheckError) {
        console.log(directoryCheckError);
        return res.json({
          success: false,
          error: directoryCheckError,
        });
      }

      // If it does, check if it's a valid directory
      if (stats.isDirectory()) {
        // Remove anything previously contained in the directory and create new subdirectories
        childProcess.exec(`
            rm -rf ./${COMPILE_DIRECTORY} && \
            mkdir -p ${COMPILE_DIRECTORY}/dlls && \
            mkdir -p ${COMPILE_DIRECTORY}/source`,
        (directoryCreationError) => {
          if (directoryCreationError) {
            console.log(directoryCreationError);
            return res.json({
              success: false,
              error: directoryCreationError,
            });
          }

          // Write the player code into a file to ready it for compilation
          fs.writeFile(`./${COMPILE_DIRECTORY}/source/player_code.cpp`, code, (playerCodeWriteError) => {
            if (playerCodeWriteError) {
              console.log(playerCodeWriteError);
              return res.json({
                success: false,
                error: playerCodeWriteError,
              });
            }

            // Launch the compile container, passing the directories as params
            // Once compile is done, the output libs are mapped back into the libs directory
            childProcess.exec(`
                    docker run \
                    -v $(pwd)/${COMPILE_DIRECTORY}/dlls:/root/output_libs \
                    -v $(pwd)/${COMPILE_DIRECTORY}/source:${PLAYER_CODE_DIRECTORY} \
                    -t ${COMPILER_IMAGE}`,
            (compilerError, stdout, stderr) => {
              // Log outputs for visibility
              console.log(stdout, stderr);

              // Handle compilation failure
              if (compilerError) {
                console.error(compilerError);
                return compilerError;
              }

              // If there was an error in compilation
              if (stdout.toLowerCase().indexOf('error') !== -1) {
                // Strip ANSI special color characters in compiler output
                const strippedStdout = stripAnsi(stdout);
                return res.json({
                  success: false,
                  error: strippedStdout,
                });
              }

              // Read the output DLLs
              const dll1 = fs.readFileSync(`./${COMPILE_DIRECTORY}/dlls/libplayer_1_code.so`);
              const dll2 = fs.readFileSync(`./${COMPILE_DIRECTORY}/dlls/libplayer_2_code.so`);

              // Return response
              return res.json({
                success: true,
                dll1,
                dll2,
              });
            });
          });
        });
      }
    });
  } catch (e) {
    console.log(e, 'Please make compilebox directory manually!');
  }
});

// Execute Route
app.post('/execute', (req, res) => {
  const { matchId } = req.body;
  let { dll1, dll2 } = req.body;

  // Read DLL data into Buffer objects
  dll1 = new Buffer.from(req.body.dll1);
  dll2 = new Buffer.from(req.body.dll2);

  try {
    // Check if the container directory exists
    fs.stat(`./${EXECUTE_DIRECTORY}`, (directoryCheckError, stats) => {
      if (directoryCheckError) {
        return res.json({
          success: false,
          error: directoryCheckError,
        });
      }

      // Check if it's a valid directory
      if (stats.isDirectory()) {
        // Remove anything previously contained in the directory and create new subdirectories
        childProcess.execSync(`
          rm -rf ./${EXECUTE_DIRECTORY} && \
          mkdir -p ${EXECUTE_DIRECTORY}/dlls && \
          mkdir -p ${EXECUTE_DIRECTORY}/output_log`);

        // Write input DLLs to file
        fs.writeFile(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/libplayer_1_code.so`, dll1, (dll1WriteError) => {
          if (dll1WriteError) throw dll1WriteError;
          fs.writeFile(`${__dirname}/${EXECUTE_DIRECTORY}/dlls/libplayer_2_code.so`, dll2, (dll2WriteError) => {
            if (dll2WriteError) throw dll2WriteError;

            // Launch the execute container, and pass output directories as parameters
            childProcess.exec(`
              docker run -v $(pwd)/${EXECUTE_DIRECTORY}/dlls:/root/input_libs \
              -v $(pwd)/${EXECUTE_DIRECTORY}/output_log:/root/output_log \
              -t ${RUNNER_IMAGE}`,
            (executionError, stdout, stderr) => {
              // Log output for visibility
              console.log(executionError, stdout, stderr);

              // If there was a visible error during runtime
              if (stdout.toLowerCase().indexOf('error') !== -1) {
                return res.json({
                  success: false,
                  error: stripAnsi(stdout),
                  matchId,
                });
              }

              // If some other runtime error occured
              if (executionError || stderr) {
                console.error(executionError);
                return res.json({
                  success: false,
                  error: stripAnsi(stdout),
                  matchId,
                });
              }

              // Get the game scores from the end of stdout
              const stdoutArray = stdout.split('\n');
              const results = stdoutArray[stdoutArray.length - 2];

              // If the game ended with an UNDEFINED status, return blank
              if (results.indexOf('UNDEFINED') !== -1) {
                return res.json({
                  success: true,
                  log: '',
                  matchId,
                  results,
                  player1LogCompressed: '',
                  player2LogCompressed: '',
                });
              }

              // Else, we write the game log to file, and compress
              const log = fs.readFileSync(`${EXECUTE_DIRECTORY}/output_log/game.log`);
              const logCompressed = zlib.gzipSync(log);

              // Write player debug logs to file, and compress
              const player1Log = fs.readFileSync(`./${EXECUTE_DIRECTORY}/output_log/player_1.dlog`);
              const player2Log = fs.readFileSync(`./${EXECUTE_DIRECTORY}/output_log/player_2.dlog`);
              const player1LogCompressed = zlib.gzipSync(player1Log);
              const player2LogCompressed = zlib.gzipSync(player2Log);

              // Return response with logs and results
              res.json({
                success: true,
                log: logCompressed,
                matchId,
                results,
                player1LogCompressed,
                player2LogCompressed,
              });
            });
          });
        });
      }
    });
  } catch (e) {
    console.error(e, 'Please create the executebox directory!');
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
