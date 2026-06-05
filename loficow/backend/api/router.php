<?php
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../middleware/cors.php';
require_once __DIR__ . '/../middleware/auth.php';

setCorsHeaders();

$path = trim($_GET['path'] ?? '', '/');
$method = $_SERVER['REQUEST_METHOD'];
$segments = explode('/', $path);
$resource = $segments[0] ?? '';
$id = $segments[1] ?? null;
$action = $segments[2] ?? null;

$routes = [
    'auth'        => __DIR__ . '/auth/',
    'users'       => __DIR__ . '/users/',
    'posts'       => __DIR__ . '/posts/',
    'channels'    => __DIR__ . '/channels/',
    'beats'       => __DIR__ . '/beats/',
    'uploads'     => __DIR__ . '/uploads/',
    'explore'     => __DIR__ . '/explore/',
    'collabs'     => __DIR__ . '/collab/',
    'submissions' => __DIR__ . '/submissions/',
    'notifications' => __DIR__ . '/notifications/',
];

// Route map: resource -> action -> file
$routeMap = [
    'auth' => [
        'POST:register' => 'auth/register.php',
        'POST:login'    => 'auth/login.php',
        'POST:logout'   => 'auth/logout.php',
        'GET:me'        => 'auth/me.php',
    ],
    'users' => [
        'GET:profile'   => 'users/profile.php',
        'PUT:profile'   => 'users/update.php',
        'POST:follow'   => 'users/follow.php',
        'DELETE:follow' => 'users/follow.php',
        'GET:feed'      => 'users/feed.php',
    ],
    'posts' => [
        'GET:index'     => 'posts/index.php',
        'POST:index'    => 'posts/create.php',
        'GET:single'    => 'posts/single.php',
        'DELETE:single' => 'posts/delete.php',
        'POST:like'     => 'posts/like.php',
        'DELETE:like'   => 'posts/like.php',
        'GET:comments'  => 'posts/comments.php',
        'POST:comments' => 'posts/comment.php',
    ],
    'channels' => [
        'GET:index'     => 'channels/index.php',
        'GET:messages'  => 'channels/messages.php',
        'POST:messages' => 'channels/send.php',
    ],
    'beats' => [
        'GET:index'     => 'beats/index.php',
        'POST:index'    => 'beats/upload.php',
        'GET:single'    => 'beats/single.php',
        'DELETE:single' => 'beats/delete.php',
        'POST:like'     => 'beats/like.php',
    ],
    'uploads' => [
        'POST:audio'    => 'uploads/audio.php',
        'POST:image'    => 'uploads/image.php',
    ],
    'explore' => [
        'GET:index'     => 'explore/index.php',
    ],
    'collabs' => [
        'GET:index'     => 'collab/index.php',
        'POST:index'    => 'collab/create.php',
        'GET:single'    => 'collab/single.php',
        'POST:respond'  => 'collab/respond.php',
    ],
    'submissions' => [
        'GET:index'      => 'submissions/index.php',
        'POST:index'     => 'submissions/create.php',
        'PUT:status'     => 'submissions/update_status.php',
    ],
    'notifications' => [
        'GET:index'     => 'notifications/index.php',
        'POST:read'     => 'notifications/mark_read.php',
    ],
];

// Resolve route
$routeKey = null;
if ($id && $action) {
    $routeKey = "$method:$action";
} elseif ($id) {
    $routeKey = "$method:single";
} else {
    $routeKey = "$method:index";
}

if (isset($routeMap[$resource][$routeKey])) {
    $file = __DIR__ . '/' . $routeMap[$resource][$routeKey];
    if (file_exists($file)) {
        require $file;
    } else {
        error("Route file not found", 500);
    }
} else {
    error("Not found", 404);
}
