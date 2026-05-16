module.exports = {
    apps: [
        {
            name: "photo-restoration",
            script: "./app.js",
            cwd: __dirname,
            exec_mode: "fork",
            instances: 1,
            watch: false,
            max_memory_restart: "512M",
            env: {
                NODE_ENV: "production",
                PORT: 3001,
            },
            out_file: "./logs/out.log",
            error_file: "./logs/err.log",
            merge_logs: true,
            log_date_format: "YYYY-MM-DD HH:mm:ss",
        },
    ],
};
