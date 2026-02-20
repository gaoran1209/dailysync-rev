const { GarminConnect } = require('@gooin/garmin-connect');

async function test() {
    const GCClient = new GarminConnect({}, 'garmin.cn');
    console.log("has fetchOauthConsumer?", typeof GCClient.client.fetchOauthConsumer);
    console.log("has getOauth1Token?", typeof GCClient.client.getOauth1Token);
    console.log("has exchange?", typeof GCClient.client.exchange);
}

test();
