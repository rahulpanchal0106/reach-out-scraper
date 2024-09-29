const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs'); // Import fs to write data to a file
const rateLimiter = require('bottleneck');

// Create a rate limiter instance
const limiter = new rateLimiter({
  minTime: 1000 // Minimum time between requests in milliseconds
});

// Function to fetch company details
async function fetchCompanyDetails(companyUrl) {
    try {
        const response = await axios.get(companyUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        // Extract company details
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

// Function to fetch all email addresses from a page
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

        // More comprehensive regex for email addresses
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

        // Search in all text nodes
        $('body').find('*').contents().each((_, element) => {
            if (element.type === 'text') {
                const matches = element.data.match(emailRegex);
                if (matches) matches.forEach(email => emails.add(email));
            }
        });

        // Search in mailto: links
        $('a[href^="mailto:"]').each((_, element) => {
            const email = $(element).attr('href').replace('mailto:', '');
            emails.add(email);
        });

        // Filter out placeholder emails and image filenames
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

// Use the limiter for API calls and web scraping
const limitedFetchCompanyDetails = limiter.wrap(fetchCompanyDetails);
const limitedFetchEmails = limiter.wrap(fetchEmails);

// Function to fetch job listings from Adzuna API
async function fetchJobListings(pageNumber) {
    try {
        const apiUrl = `https://api.adzuna.com/v1/api/jobs/in/search/${pageNumber}?app_id=0d95e10e&app_key=9b0a9ce4c6fa0b7be1bf4cc14d760de7`;
        const response = await axios.get(apiUrl);
        
        // Extract useful job details
        return response.data.results.map(job => ({
            companyName: job.company.display_name,
            jobDescription: job.description,
            location: job.location.display_name,
            listingDate: job.created, // Add this line to include the listing date
        }));
    } catch (error) {
        console.error(`Error fetching job listings from Adzuna: ${error.message}`);
        return [];
    }
}

// Function to search for company websites (Using DuckDuckGo as an alternative)
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

        // DuckDuckGo-specific scraping
        $('a.result__a').each((i, element) => {
            if (results.length >= numResults) return false;
            const link = $(element).attr('href');
            if (link && link.startsWith('http')) {
                results.push(link);
            }
        });

        if (results.length === 0) {
            console.log('No results found. DuckDuckGo might be blocking the request.');
        } else {
            console.log('Search results:', results);
        }

        return results;
    } catch (error) {
        console.error(`Error searching for company websites: ${error.message}`);
        return [];
    }
}

// Function to save data to a JSON file
function saveToFile(data) {
    let existingData = [];
    if (fs.existsSync('job_data.json')) {
        const fileContent = fs.readFileSync('job_data.json', 'utf8');
        existingData = JSON.parse(fileContent);
    }
    const updatedData = mergeNewJobs(existingData, data);
    fs.writeFileSync('job_data.json', JSON.stringify(updatedData, null, 2));
}

// Function to merge new jobs with existing data
function mergeNewJobs(existingData, newData) {
    const mergedData = [...existingData];
    newData.forEach(newJob => {
        const existingJobIndex = mergedData.findIndex(job => 
            job.companyName === newJob.companyName && 
            job.jobDescription === newJob.jobDescription &&
            job.location === newJob.location
        );
        if (existingJobIndex === -1) {
            mergedData.push(newJob);
        } else {
            // Update existing job if needed
            mergedData[existingJobIndex] = {
                ...mergedData[existingJobIndex],
                ...newJob
            };
        }
    });
    return mergedData;
}

// Consider adding more robust error handling and retries
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

// Main function to run the automation
(async () => {
    let pageNumber = 55;
    const maxPages = 65;

    while (pageNumber <= maxPages) {
        const jobListings = await fetchWithRetry(fetchJobListings, pageNumber);
        const allData = [];

        for (const job of jobListings) {
            const { companyName, jobDescription, location, listingDate } = job;
            console.log(`Processing ${companyName}...`);
            
            const websites = await fetchWithRetry(searchCompanyWebsites, `${companyName} company website`);

            for (const website of websites) {
                const companyDetails = await fetchWithRetry(limitedFetchCompanyDetails, website);

                if (companyDetails) {
                    let emails = await fetchWithRetry(limitedFetchEmails, website);
                    if (companyDetails.careersPage) {
                        const careerEmails = await fetchWithRetry(limitedFetchEmails, companyDetails.careersPage);
                        emails = [...new Set([...emails, ...careerEmails])];
                    }
                    const jobData = {
                        companyName: companyName,
                        companyInfo: companyDetails.name,
                        jobDescription,
                        location,
                        listingDate,
                        careersPage: companyDetails.careersPage,
                        emails: emails,
                    };
                    allData.push(jobData);
                    console.log(`Company Name: ${companyName}`);
                    console.log(`Company Info: ${companyDetails.name}`);
                    console.log(`Job Description: ${jobDescription}`);
                    console.log(`Location: ${location}`);
                    console.log(`Listing Date: ${listingDate}`);
                    console.log(`Website: ${website}`);
                    console.log(`Careers Page: ${companyDetails.careersPage}`);
                    console.log(`Emails: ${emails.join(', ')}`);
                    console.log('---');
                    break;
                }
            }
            saveToFile(allData);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        console.log(`Completed processing page ${pageNumber}`);
        pageNumber++;
    }
})();