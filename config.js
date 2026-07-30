module.exports = {
    name: 'RIO X MD',
    owner: 'RIO X',
    number: '947XXXXXXXX',
    prefix: '.',
    port: process.env.PORT || 3000,
    publicUrl: process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${process.env.PORT || 3000}`,
    maxSessions: 30,
    ramLimit: 384
};
