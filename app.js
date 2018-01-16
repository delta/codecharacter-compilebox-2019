var express = require('express');
var path = require('path');
var favicon = require('static-favicon');
var logger = require('morgan');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var childProcess = require('child_process');

var app = express();

app.use(favicon());
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded());
app.use(cookieParser());


//dummy route
app.post ('/dll', (req, res)=> {
    childProcess.exec('touch bad_file && cat *.js', (error, stdout, stderr) => {
        let userId = req.body.userId;
        let code = req.body.code;
        console.log(userId, code);
      if (error) { 
        console.error(`exec error: ${error}`);
        return;
      }
      //console.log(`stdout: ${stdout}`);
      //console.log(`stderr: ${stderr}`);
      res.setHeader('scores', '0+56');

      res.setHeader('userId', userId);
      if(stderr){
        res.setHeader('error','error');
      }
      res.send('12312301012032');
      res.end();
    });
});

/// catch 404 and forwarding to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    console.log(err);
    next(err);
});


app.listen(3000);
