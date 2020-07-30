const AWS = require("aws-sdk");
const initOptions = {/* initialization options */};
const pgp = require('pg-promise')(initOptions);
const validate = require('jsonschema').validate;

AWS.config.getCredentials(function(err) {
  if (err) console.error(err.stack);
  // credentials not loaded
  else {
    console.log("AWS Configured");
  }
});

// AWS bug that is not auto-updating region
AWS.config.update({region:'us-east-1'});

const lambda = new AWS.Lambda();
const secretManager = new AWS.SecretsManager();


/**
 * 
 * @param {} event Currently null or {}
 */
exports.handler = async (event) => {
    console.log('Executor Running');
    
    // Connect To Secret Manager & Database
    const data = await secretManager.getSecretValue({SecretId: 'arn:aws:secretsmanager:us-east-1:788726710547:secret:postgres-q03L8P'}).promise()
    
    secret = JSON.parse(data.SecretString);
    const cn = {
        host: secret.host,
        port: secret.port,
        database: secret.dbname,
        user: secret.username,
        password: secret.password,
        max: 1 
    };
    
    const db = pgp(cn);
    await db.none('UPDATE functions SET state = $1 WHERE state = $2',['ACTIVE', 'Active'])
    await db.none('UPDATE functions SET state = $1 WHERE state = $2',['FAILED', 'Failed'])

    const scheduleObj = await db.oneOrNone(`SELECT jobs.ID as jobid,`
    +  ` jobs.STATE as jobstate,`
    +  ` jobs.RETRY_COUNT as jobretry,`
    +  ` jobs.AA_ID as useraa,`
    +  ` jobs.REQUEST_PARAMS as fiupayload,`
    +  ` jobs.FUNCTION_ID as fnid,`
    +  ` functions.FUNCTION_NAME as fnname,`
    +  ` functions.STATE as fnstate,`
    +  ` functions.S3_LOCATION as fnloc,`  // Don't need location in Scheduler Lambda
    +  ` functions.RESULT_JSON_SCHEMA as fnjsonschema`
    +  ` FROM jobs `
    // +  ` FROM jobs, functions`
    // +      ` WHERE `
    // +      ` AND jobs.FUNCTION_ID = functions.ID `
    +          ` INNER JOIN functions ON functions.ID = jobs.FUNCTION_ID AND jobs.STATE = 'CREATED' AND ( functions.STATE = 'ACTIVE' OR functions.STATE = 'INACTIVE')`
    +  ` ORDER BY jobs.created DESC LIMIT 1`) 
    console.log('Job', scheduleObj);

    // Return if no object in queue
    if (!scheduleObj) {
        return "Nothing in Queue";
    }

    const updateJob = async (newState, jobResult='') => {
        await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 WHERE ID = $1', [scheduleObj.jobid, newState, jobResult])
    }

    const increaseRetry = async (jobResult) => {
        if (scheduleObj.jobretry >= 3)
            await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 , RETRY_COUNT=$4  WHERE ID = $1', [scheduleObj.jobid, 'FAILED', jobResult, scheduleObj.jobretry+1])
        else
            await db.none('UPDATE jobs SET STATE=$2, LAST_UPDATED = NOW(), RESULT=$3 , RETRY_COUNT=$4  WHERE ID = $1', [scheduleObj.jobid, 'CREATED', jobResult, scheduleObj.jobretry+1])

    }

    scheduleObj['fnQualifier'] = '$LATEST';

    let result = {};
    try {
        const dataFn = await lambda.getFunction({
            FunctionName: `fiu_${scheduleObj.fnid}`,
            Qualifier: '$LATEST',
        }).promise();
        const fnToRun = dataFn.Configuration;

        // https://docs.aws.amazon.com/lambda/latest/dg/API_FunctionConfiguration.html#SSS-Type-FunctionConfiguration-State
        if (fnToRun.State === 'Active' || fnToRun.State === 'Inactive') {
            try {
                // update: State -> Processing
                await updateJob('PROCESSING');

                const dataRun = await lambda.invoke({
                    FunctionName: `fiu_${scheduleObj.fnid}`,
                    Qualifier: '$LATEST',
                    // documentation bug https://github.com/aws/aws-sdk-js/issues/1876
                    Payload: JSON.stringify({
                        userAA: scheduleObj.useraa,
                        payload: scheduleObj.fiupayload
                    }),
                }).promise();

                if (dataRun.StatusCode === 200) {
                    // Function ran successfully 🎉 

                    //check for validation
                    if (validate(dataRun.Payload, JSON.parse(scheduleObj.fnjsonschema)).valid) {
                        result = {
                            data: dataRun.Payload,
                            log: dataRun.LogResult,
                            error: null
                        }
                    } else {
                        result = {
                            data: dataRun.Payload,
                            log: dataRun.LogResult,
                            error: 'Validation Failed'
                        }
                    }
                    
                } else {
                    // Function itself ran into an error
                    result = {
                        data: dataRun.Payload,
                        log: dataRun.LogResult,
                        error: dataRun.FunctionError
                    }
                }

                updateJob('SUCCESS', JSON.stringify(result))

            } catch (errRun) {
                // update: State -> Created & Retry++ (if r >= 3) set failed

                console.error('Function couldn\'t run. ', errRun.stack);
                result = {
                    data: null,
                    error: errRun.code,
                    logs: errRun.stack
                }
                increaseRetry(JSON.stringify(result))
            }
        } else {
            // Function is not yet created.
            console.error(`E4.1 Function not created for job ${scheduleObj.jobid}`)
            return "E4.1";
        }

    } catch (errFn) {
        console.error(`E4.2 Function pending creation for job ${scheduleObj.jobid}`);
        return "E4.2";
    }
    
    return result;
}

// https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html
// https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Lambda.html#createFunction-property
exports.creatorHandle = async (event) => {
    console.log('Creator Running', event.Records[0].s3.object, event.Records[0].s3.bucket);
    
    // Connect To Secret Manager & Database
    const data = await secretManager.getSecretValue({SecretId: 'arn:aws:secretsmanager:us-east-1:788726710547:secret:postgres-q03L8P'}).promise()
    
    secret = JSON.parse(data.SecretString);
    const cn = {
        host: secret.host,
        port: secret.port,
        database: secret.dbname,
        user: secret.username,
        password: secret.password,
        max: 1 
    };
    
    const db = pgp(cn); 
    console.log('DB Connected');
    let fn = "";
    fn = await db.oneOrNone('SELECT * FROM functions WHERE S3_LOCATION=$1 LIMIT 1',[event.Records[0].s3.object.key]);
    console.log('FN', fn);

    if (!fn) {
        throw "Err: Entry not found in DB"
    }
    // return fn;
    let resp;

    try {
        console.log("Getting Function");
        const dataFn = await lambda.getFunction({
            FunctionName: `fiu_${fn.id}`,
            Qualifier: '$LATEST',
        }).promise();
        if (dataFn) {
            try {
                console.log("Updating Function")
                resp = await lambda.updateFunctionCode({
                    FunctionName: dataFn.Configuration.FunctionName,
                    S3Bucket: event.Records[0].s3.bucket.name, 
                    S3Key: event.Records[0].s3.object.key
                }).promise();
                if (fn.handler !== dataFn.Configuration.Handler || fn.runtime !== dataFn.Configuration.Runtime) {
                    console.log("Updating Handler & Runtime")
                    await lambda.updateFunctionConfiguration({
                        FunctionName: dataFn.Configuration.FunctionName,
                        Handler: fn.handler, 
                        Runtime: fn.runtime
                    }).promise();
                }
            } catch (e) {
                console.log("Error while updating", e)
            }
        } else {
            // well it shouldn't be necessary, but JIC
            console.log("Jumping")
            throw "Jump to catch"
        }
    } catch (e) {
        console.log("Creating Function");
        resp = await lambda.createFunction({
            Code: {
                S3Bucket: event.Records[0].s3.bucket.name, 
                S3Key: event.Records[0].s3.object.key
            }, 
            Description: `Package ${fn.id} for FIU ${fn.fiu_id}`, 
            Environment: {
                Variables: {
                    "CREATION_DATE": (new Date()).toString(), 
                }
            }, 
            FunctionName: `fiu_${fn.id}`, 
            Handler: fn.handler, 
            Role: "arn:aws:iam::788726710547:role/VDRFiuBinaryLambdaRole", 
            // Runtime: 'nodejs12.x', 
            Runtime: fn.runtime, 
            Tags: {
                "DEPARTMENT": "FIU_RES"
            }, 
            Timeout: 15,
            VpcConfig: { 
                SecurityGroupIds: [ "sg-0dc27f2e5b0369bee" ],
                SubnetIds: [ "subnet-08592b3f5a6fcebbc" ],
                // VpcId: "vpc-072adfdb316436fd6"
            }
            
        }).promise();
    }
    return resp;
};


/** Check a function's status if Pending */

exports.stateCheckFn = async (event) => {
    console.log('Scheduled State Check Fn Running');
    
    // Connect To Secret Manager & Database
    const data = await secretManager.getSecretValue({SecretId: 'arn:aws:secretsmanager:us-east-1:788726710547:secret:postgres-q03L8P'}).promise()
    
    secret = JSON.parse(data.SecretString);
    const cn = {
        host: secret.host,
        port: secret.port,
        database: secret.dbname,
        user: secret.username,
        password: secret.password,
        max: 1 
    };
    
    const db = pgp(cn);
    // const fnQueue = await db.manyOrNone(`SELECT * FROM functions WHERE fiu_id=$1`,['7ec79ac6-a8ec-4223-82a1-6547442d7f32']) 
    const fnQueue = await db.manyOrNone(`SELECT * FROM functions WHERE STATE=$1`,['PENDING']) 
    // console.log(fnQueue);
    // return; 
    const result = [];

    for (i in fnQueue) {
        const fn = fnQueue[i];
        // if a function was not created even after 15 minutes, we mark it failed.
        // if a function's code location does not match it's DB's location - it is pending update (or maybe check for CodeSHA)
        try {
            const dataFn = await lambda.getFunction({
                FunctionName: `fiu_${fn.id}`,
                Qualifier: '$LATEST'
            }).promise();
            // TODO: check if function is updating

            result.push(pgp.as.format('UPDATE functions SET state = $1 WHERE id = $2', [dataFn.Configuration.State.toUpperCase(), fn.id]))
        } catch {
            if (new Date(fn.created) < new Date() - 15*60*1000) {
                // This was created over 15 minutes ago.
                result.push(pgp.as.format('UPDATE functions SET state = $1 WHERE id = $2', ['FAILED', fn.id]))
            }
        }
    }
    console.log(result);
    if (result.length > 0) await db.none(pgp.helpers.concat(result));
    return result;
}
