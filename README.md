# Scheduler Lambda

## Setup & Configuration

Make sure aws cli, node and [ncc](github.com/vercel/ncc) are installed. Configure aws cli with `aws configure`

1. Get the .env file and store it in root
2. Install with `npm i`
3. Build with `npm run build`
4. Deploy creatorFn with `npm run deploy:creator`
5. Deploy executorFn with `npm run deploy:executor`
