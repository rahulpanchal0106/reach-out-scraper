const mongoose = require('mongoose');
const Job = require('./job_data.json');

// Connect to MongoDB
mongoose.connect('mongodb+srv://rm5901960:pRPHdyfTs8x8ud4b@cluster0.9mgmw.mongodb.net/reach-out?retryWrites=true&w=majority&appName=Cluster0', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Define the Job schema
const jobSchema = new mongoose.Schema({
    companyName: String,
    companyInfo: String,
    jobDescription: String,
    location: String,
    listingDate: String, 
    careersPage: String,
    emails: [String]
});

// Create the Job model
const Jobs = mongoose.model('Job', jobSchema);

// Upload data to MongoDB
Jobs.insertMany(Job)

module.exports = Jobs;