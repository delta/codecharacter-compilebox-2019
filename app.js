const express = require('express');
const path = require('path');
const favicon = require('static-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const childProcess = require('child_process');
//impotrt from somewhere
const secretString = "I_am_aw3sOme";
const app = express();
const fs = require('fs');
app.use(favicon());
app.use(logger('dev'));
app.use(bodyParser.json({limit:'50mb'}));
app.use(bodyParser.urlencoded({limit:'50mb'}));
app.use(cookieParser());


//dummy route
app.post ('/compile', (req, res)=> {
    
    let userId = req.body.userId;
    let code = req.body.code;
    console.log(userId);
//    fs.rmdir('')
    fs.stat('./compilebox_transaction', (err, stats) => {
      if(err) {
        console.log(err);
        return res.json({success: false});
      }
      if(stats.isDirectory()){
        childProcess.execSync('rm -rf ./compilebox_transaction && mkdir compilebox_transaction && mkdir compilebox_transaction/dlls && mkdir compilebox_transaction/source');

        fs.writeFile('./compilebox_transaction/source/player_code.cpp', code, (err) => {
            if (err) throw err;
            //prepare
            childProcess.exec(
              `
                docker run -v $(pwd)/compilebox_transaction/dlls:/root/output_libs -v $(pwd)/compilebox_transaction/source:/root/codecharacter/src/player_code/src -t deltanitt/codecharacter-compiler
              `, 
              (error, stdout, stderr) => {
                console.log(error, stderr, stdout);
                if(req.body.secretString != "I_am_aw3sOme"){
                    return res.json({code: 404, message:"Bad request!"});
                }
                //let respo
                console.log(fs.readFileSync('./compilebox_transaction/dlls/libplayer_1_code.so'), fs.readFileSync('./compilebox_transaction/dlls/libplayer_2_code.so'), '1');
                let dll1 = fs.readFileSync('./compilebox_transaction/dlls/libplayer_1_code.so');
                let dll2 = fs.readFileSync('./compilebox_transaction/dlls/libplayer_2_code.so');
                if (error) { 
                  console.error(`exec error: ${error}`);
                  return;
                }
                //console.log(`stdout: ${stdout}`);
                //console.log(`stderr: ${stderr}`);
                res.setHeader('scores', '0+56');

                res.setHeader('user_id', userId);

                if(stdout.toLowerCase().indexOf('error') != -1){
                  return res.json({
                    success: false,
                    error: stdout
                  });
                }
                return res.json({
                  success: true,
                  dll1,
                  dll2
                });
            });
        });
      }
    })
});
app.post ('/execute', (req, res)=> {
    let matchId = req.body.matchId;
    let dll1 = new Buffer.from(req.body.dll1);
    let dll2 = new Buffer.from(req.body.dll2);
    //dll1 = Buffer.from(dll1, 'base64');
    //dll2 = Buffer.from(dll2, 'base64');
    fs.stat('./executebox_transaction', (err, stats) => {
      if(err) {
        console.log(err);
        return res.json({success: false});
      }
      if(stats.isDirectory()){
        childProcess.execSync('rm -rf ./executebox_transaction && mkdir executebox_transaction && mkdir executebox_transaction/dlls && mkdir executebox_transaction/output_log');
        //fs.writeFileSync('./executebox_transaction/dlls/libplayer_1_code.so', dll1);
        //fs.writeFileSync('./executebox_transaction/dlls/libplayer_2_code.so', dll2);
        fs.writeFile(__dirname+'/executebox_transaction/dlls/libplayer_1_code.so', dll1, (err) => {
            if (err) throw err;
            fs.writeFile(__dirname+'/executebox_transaction/dlls/libplayer_2_code.so', dll2, (err) => {
              if(err) throw err; 
              //prepare
              childProcess.exec(
                `
                  docker run -v $(pwd)/executebox_transaction/dlls:/root/input_libs -v $(pwd)/executebox_transaction/output_log:/root/output_log -t deltanitt/codecharacter-runner
                `, 
                (error, stdout, stderr) => {
                  let log = fs.readFileSync('executebox_transaction/output_log/game.log');

                  if(stdout.toLowerCase().indexOf('error') != -1){
                    return res.json({
                      success: false,
                      error: stdout,
                      matchId
                    });
                  }

                  if (error || stderr) { 
                    console.log(error, stdout, stderr);
                    console.error(`exec error: ${error}`);
                    return res.json({
                      success: false,
                      error: stdout,
                      matchId
                    });
                  }

                  res.json({success: true, log: log, matchId});
              });
            })
        });
      }
    })
});

/// catch 404 and forwarding to error handler
app.use(function(req, res, next) {
    let err = new Error('Not Found');
    err.status = 404;
    console.log(err);
    next(err);
});


app.listen(3002);
