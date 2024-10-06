const axios = require('axios');
const cheerio = require('cheerio');
const rateLimiter = require('bottleneck');
const express = require('express');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

mongoose.connect(process.env.MONGODB_URI);
mongoose.connection.on('connected', () => {
    console.log('Connected to MongoDB');
});
mongoose.connection.on('error', (err) => {
    console.error('Error connecting to MongoDB:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;

const limiter = new rateLimiter({
  minTime: 1000
});

// Changed collection name from 'latestJobs' to 'jobListings'
const Job = mongoose.model('Job', new mongoose.Schema({
    companyName: String,
    companyInfo: String,
    jobDescription: String,
    location: String,
    listingDate: Date,
    careersPage: String,
    emails: [String],
    scannedPages: [String]
}, { collection: 'jobListings' }));

async function fetchCompanyDetails(companyUrl) {
    try {
        const response = await axios.get(companyUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        const companyName = $('title').text();
        const careersPageLink = $('a').filter((i, el) => $(el).text().toLowerCase().includes('careers') || $(el).text().toLowerCase().includes('career')).attr('href');

        return {
            name: companyName,
            careersPage: careersPageLink ? (careersPageLink.startsWith('http') ? careersPageLink : new URL(careersPageLink, companyUrl).href) : null,
        };
    } catch (error) {
        console.error(`Error fetching company details: ${error.message}`);
        return null;
    }
}

async function fetchEmails(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        const emails = new Set();

        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

        $('body').find('*').contents().each((_, element) => {
            if (element.type === 'text') {
                const matches = element.data.match(emailRegex);
                if (matches) matches.forEach(email => emails.add(email));
            }
        });

        $('a[href^="mailto:"]').each((_, element) => {
            const email = $(element).attr('href').replace('mailto:', '');
            emails.add(email);
        });

        const filteredEmails = Array.from(emails).filter(email => 
            !email.includes('example') && 
            !email.includes('placeholder') &&
            !email.toLowerCase().endsWith('.png') &&
            !email.toLowerCase().endsWith('.jpg') &&
            !email.toLowerCase().endsWith('.jpeg') &&
            !email.toLowerCase().endsWith('.gif') &&
            !email.startsWith('?') &&
            !email.includes('/')
        );

        return filteredEmails.length > 0 ? filteredEmails : [];
    } catch (error) {
        console.error(`Error fetching emails: ${error.message}`);
        return [];
    }
}

const limitedFetchCompanyDetails = limiter.wrap(fetchCompanyDetails);
const limitedFetchEmails = limiter.wrap(fetchEmails);

async function fetchJobListings(pageNumber) {
    try {
        const apiUrl = process.env.ADZUNA_API;
        const response = await axios.get(apiUrl);
        
        return response.data.results.map(job => ({
            companyName: job.company.display_name,
            jobDescription: job.description,
            location: job.location.display_name,
            listingDate: job.created,
        }));
    } catch (error) {
        console.error(`Error fetching job listings from Adzuna: ${error.message}`);
        return [];
    }
}

async function searchCompanyWebsites(query, numResults = 5) {
    try {
        const searchUrl = `https://duckduckgo.com/html?q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const results = [];

        $('a.result__a').each((i, element) => {
            if (results.length >= numResults) return false;
            const link = $(element).attr('href');
            if (link && link.startsWith('http')) {
                results.push(link);
            }
        });

        return results;
    } catch (error) {
        console.error(`Error searching for company websites: ${error.message}`);
        return [];
    }
}

async function saveToMongo(dataArray) {
    try {
        for (const data of dataArray) {
            const existingJob = await Job.findOne({ companyName: data.companyName, location: data.location });
            if (!existingJob) {
                const job = new Job(data);
                await job.save();
            } else {
                console.log(`Job for ${data.companyName} at ${data.location} already exists in the database.`);
            }
        }
        console.log('Job data saved to MongoDB successfully');
    } catch (error) {
        console.error(`Error saving job data to MongoDB: ${error.message}`);
    }
}



const maxRetries = 3;
async function fetchWithRetry(func, ...args) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await func(...args);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
}

async function pingWebService() {
    try {
        await axios.get(process.env.PROD || 'http://localhost:3000');
        console.log('Web service pinged successfully');
    } catch (error) {
        console.error('Error pinging web service:', error.message);
    }
}

async function runJobSearch() {
    let pageNumber = 0;
    const maxPages = 1;

    while (pageNumber <= maxPages) {
        const jobListings = await fetchWithRetry(fetchJobListings, pageNumber);
        const allData = [];
        const scannedPages = [];

        for (const job of jobListings) {
            const { companyName, jobDescription, location, listingDate } = job;
            console.log(`Processing ${companyName}...`);
            
            const websites = await fetchWithRetry(searchCompanyWebsites, `${companyName} company website`);

            let companyEmails = [];
            for (const website of websites) {
                const companyDetails = await fetchWithRetry(limitedFetchCompanyDetails, website);

                if (companyDetails) {
                    let emails = await fetchWithRetry(limitedFetchEmails, website);
                    scannedPages.push(website);

                    if (companyDetails.careersPage) {
                        const careerEmails = await fetchWithRetry(limitedFetchEmails, companyDetails.careersPage);
                        emails = [...new Set([...emails, ...careerEmails])];
                        scannedPages.push(companyDetails.careersPage);
                    }

                    companyEmails = [...new Set([...companyEmails, ...emails])];

                    if (companyEmails.length > 0) {
                        const jobData = {
                            companyName: companyName,
                            companyInfo: companyDetails.name,
                            jobDescription,
                            location,
                            listingDate,
                            careersPage: companyDetails.careersPage,
                            emails: companyEmails,
                            scannedPages: scannedPages
                        };
                        allData.push(jobData);
                        console.log(`Company Name: ${companyName}`);
                        console.log(`Company Info: ${companyDetails.name}`);
                        console.log(`Job Description: ${jobDescription}`);
                        console.log(`Location: ${location}`);
                        console.log(`Listing Date: ${listingDate}`);
                        console.log(`Website: ${website}`);
                        console.log(`Careers Page: ${companyDetails.careersPage}`);
                        console.log(`Emails: ${companyEmails.join(', ')}`);
                        console.log(`Scanned Pages: ${scannedPages.join(', ')}`);
                        console.log('---');
                        break;
                    }
                }
            }

            if (companyEmails.length === 0) {
                console.log(`No emails found for ${companyName} after scanning all pages.`);
                const jobData = {
                    companyName: companyName,
                    jobDescription,
                    location,
                    listingDate,
                    emails: [],
                    scannedPages: scannedPages
                };
                allData.push(jobData);
            }

            await saveToMongo(allData);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log(`Completed processing page ${pageNumber}`);
        pageNumber++;
    }
}

async function main() {
    console.log('Starting job search process...');
    await pingWebService();
    console.log('Waiting for 1 minute before starting the job search...');
    await new Promise(resolve => setTimeout(resolve, 6000));
    await runJobSearch();
    console.log('Job search process completed.');
}

// Set up Express routes
app.get('/', (req, res) => {
    res.status(200).send('Job Search Scraper is running');
});

app.get('/run', async (req, res) => {
    res.send('Job search process started');
    await main();
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Run the main function every 24 hours
setInterval(main, 24 * 60 * 60 * 1000);

// Initial run
main();