<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'your_db_name');      // Change this
define('DB_USER', 'your_db_user');      // Change this
define('DB_PASS', 'your_db_password');  // Change this
define('DB_CHARSET', 'utf8mb4');

define('JWT_SECRET', 'change_this_to_a_long_random_string_64chars');
define('UPLOAD_PATH', __DIR__ . '/../uploads/');
define('BASE_URL', 'https://loficow.com/api');
define('ALLOWED_ORIGINS', ['https://loficow.com', 'http://localhost:5173']);

function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=" . DB_CHARSET;
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ];
        $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
    }
    return $pdo;
}
