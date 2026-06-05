<?php
$user = requireAuth();
unset($user['password']);
json(['user' => $user]);
