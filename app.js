const express = require('express');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const session = require('express-session');
const User = require('./models/User');

const app = express();
app.set('view engine', 'ejs');
app.set('views', 'views');

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session management
app.use(session({
    secret: 'agriconnect-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true in production with HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// In-memory user storage for when MongoDB is not available
let inMemoryUsers = [];
let nextUserId = 1;

// MongoDB connection (optional for development)
mongoose.connect('mongodb://localhost:27017/agriconnect').then(() => {
    console.log('Connected to MongoDB');
}).catch((err) => {
    console.warn('MongoDB connection failed - running without database:', err.message);
    console.warn('Please make sure MongoDB is running on localhost:27017');
});

// Helper function to check if MongoDB is connected
const isMongoConnected = () => {
    return mongoose.connection.readyState === 1;
};

// In-memory User model fallback
class InMemoryUser {
    constructor(data) {
        this._id = 'mem_' + nextUserId++;
        this.username = data.username;
        this.email = data.email;
        this.password = data.password; // Plain text password storage
        this.createdAt = new Date();
        this.updatedAt = new Date();
    }
    
    async save() {
        if (isMongoConnected()) {
            // Use real MongoDB if available
            const realUser = new User(this);
            return await realUser.save();
        } else {
            // Use in-memory storage
            const existingIndex = inMemoryUsers.findIndex(u => u._id === this._id);
            if (existingIndex >= 0) {
                inMemoryUsers[existingIndex] = this;
            } else {
                inMemoryUsers.push(this);
            }
            return this;
        }
    }
    
    static async findOne(query) {
        if (isMongoConnected()) {
            return await User.findOne(query);
        } else {
            if (query.$or) {
                return inMemoryUsers.find(user => 
                    query.$or.some(condition => {
                        if (condition.email) return user.email === condition.email;
                        if (condition.username) return user.username === condition.username;
                        if (condition._id) return user._id === condition._id;
                        return false;
                    })
                );
            } else if (query.email) {
                return inMemoryUsers.find(user => user.email === query.email);
            } else if (query.username) {
                return inMemoryUsers.find(user => user.username === query.username);
            }
            return null;
        }
    }
    
    static async find() {
        if (isMongoConnected()) {
            return await User.find().sort({ createdAt: -1 });
        } else {
            return [...inMemoryUsers].sort((a, b) => b.createdAt - a.createdAt);
        }
    }
    
    static async findByIdAndDelete(id) {
        if (isMongoConnected()) {
            return await User.findByIdAndDelete(id);
        } else {
            const index = inMemoryUsers.findIndex(user => user._id === id);
            if (index >= 0) {
                const deleted = inMemoryUsers[index];
                inMemoryUsers.splice(index, 1);
                return deleted;
            }
            return null;
        }
    }
    
    static async findById(id) {
        if (isMongoConnected()) {
            return await User.findById(id);
        } else {
            return inMemoryUsers.find(user => user._id === id);
        }
    }
    
    // Compare password method (plain text comparison)
    async comparePassword(candidatePassword) {
        return this.password === candidatePassword;
    }
}

// Middleware to check if user is logged in
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
};


app.get('/', async (req, res) => {
    // Always show user list without authentication requirement
    try {
        const users = await InMemoryUser.find();
        res.render('index', {
            title: 'User Management',
            username: req.session.username || 'Guest',
            users: users,
            message: req.query.message ? JSON.parse(req.query.message) : undefined
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.render('index', {
            title: 'User Management',
            username: req.session.username || 'Guest',
            users: [],
            message: { type: 'error', text: 'Error fetching users' }
        });
    }
});


// Authentication Routes

// Login page
app.get('/login', (req, res) => {
    res.render('login', {
        title: 'Login'
    });
});

// Handle login
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Find user by email
        const user = await InMemoryUser.findOne({ email });
        if (!user) {
            return res.render('login', {
                title: 'Login',
                error: 'Invalid email or password'
            });
        }
        
        // Compare password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.render('login', {
                title: 'Login',
                error: 'Invalid email or password'
            });
        }
        
        // Set session
        req.session.userId = user._id;
        req.session.username = user.username;
        
        res.redirect('/');
    } catch (error) {
        console.error('Login error:', error);
        res.render('login', {
            title: 'Login',
            error: 'An error occurred during login'
        });
    }
});

// Signup page
app.get('/signup', (req, res) => {
    res.render('signup', {
        title: 'Sign Up'
    });
});

// Handle signup
app.post('/signup', async (req, res) => {
    try {
        const { username, email, password, confirmPassword } = req.body;
        
        // Validate passwords match
        if (password !== confirmPassword) {
            return res.render('signup', {
                title: 'Sign Up',
                error: 'Passwords do not match'
            });
        }
        
        // Check if user already exists
        const existingUser = await InMemoryUser.findOne({ 
            $or: [{ email }, { username }] 
        });
        
        if (existingUser) {
            return res.render('signup', {
                title: 'Sign Up',
                error: 'User with this email or username already exists'
            });
        }
        
        // Create new user
        const newUser = new InMemoryUser({
            username,
            email,
            password
        });
        
        await newUser.save();
        
        res.render('login', {
            title: 'Login',
            success: 'Account created successfully! Please login.'
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.render('signup', {
            title: 'Sign Up',
            error: 'An error occurred during signup'
        });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/login');
    });
});

// Simple Edit User Form
app.get('/users/:id/edit', async (req, res) => {
    try {
        const user = await InMemoryUser.findById(req.params.id);
        if (!user) {
            const message = { type: 'error', text: 'User not found' };
            return res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
        }
        
        res.render('edit-user', {
            title: 'Edit User',
            username: req.session.username || 'Guest',
            user: user
        });
    } catch (error) {
        console.error('Error fetching user for edit:', error);
        const message = { type: 'error', text: 'Error fetching user for edit' };
        res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
    }
});

// Simple Edit User Handler
app.post('/users/:id/edit', async (req, res) => {
    try {
        const { username, email, changePassword, newPassword } = req.body;
        
        const user = await InMemoryUser.findById(req.params.id);
        if (!user) {
            const message = { type: 'error', text: 'User not found' };
            return res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
        }
        
        // Check if username/email is already taken by another user
        const existingUser = await InMemoryUser.findOne({ 
            $or: [{ email }, { username }],
            _id: { $ne: req.params.id }
        });
        
        if (existingUser) {
            return res.render('edit-user', {
                title: 'Edit User',
                username: req.session.username || 'Guest',
                user: user,
                error: 'Username or email already exists'
            });
        }
        
        // Update user info
        user.username = username;
        user.email = email;
        
        // Update password if requested
        if (changePassword && newPassword) {
            user.password = newPassword;
        }
        
        await user.save();
        
        const message = { type: 'success', text: 'User updated successfully!' };
        res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
    } catch (error) {
        console.error('Error updating user:', error);
        const user = await InMemoryUser.findById(req.params.id);
        res.render('edit-user', {
            title: 'Edit User',
            username: req.session.username || 'Guest',
            user: user,
            error: 'Error updating user. Please try again.'
        });
    }
});

// Simple Delete User
app.get('/users/:id/delete', async (req, res) => {
    try {
        const user = await InMemoryUser.findByIdAndDelete(req.params.id);
        if (!user) {
            const message = { type: 'error', text: 'User not found' };
            return res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
        }
        
        const message = { type: 'success', text: 'User deleted successfully!' };
        res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
    } catch (error) {
        console.error('Error deleting user:', error);
        const message = { type: 'error', text: 'Error deleting user' };
        res.redirect(`/?message=${encodeURIComponent(JSON.stringify(message))}`);
    }
});


app.listen(3000, () => {
    console.log(`Server is running on http://localhost:3000`);
});
